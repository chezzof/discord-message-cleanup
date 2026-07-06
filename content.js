const BRIDGE_REQUEST_EVENT = "discordCleanupBridgeRequest";
const BRIDGE_RESPONSE_EVENT = "discordCleanupBridgeResponse";

let currentUser = null;
let messageIds = [];
let deleteIndex = 0;
let paused = false;
let stopped = false;
let scanning = false;
let deleting = false;

let bridgeRequestId = 0;
let pageBridgeReady = false;
let pageBridgeInitPromise = null;

const NON_DELETABLE_MESSAGE_TYPES = new Set([1, 2, 3, 4, 5, 21]);
const SEARCH_PAGE_SIZE = 25;
const MAX_DELETE_CONCURRENCY = 2;

let messageIdSet = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseChannelId(pathname) {
  const route = parseDiscordRoute(pathname);
  return route ? route.channelId : null;
}

function parseDiscordRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "channels" || parts.length < 3) {
    return null;
  }

  if (parts[1] === "@me") {
    return {
      guildId: null,
      channelId: parts[2] || null,
      isDm: true,
    };
  }

  return {
    guildId: parts[1] || null,
    channelId: parts.length >= 4 ? parts[3] : parts[2] || null,
    isDm: false,
  };
}

function clearSensitiveState() {
  currentUser = null;
  messageIds = [];
  messageIdSet = new Set();
  deleteIndex = 0;
}

function isOwnDeletableMessage(message, user) {
  return (
    message.author &&
    message.author.id === user.id &&
    !NON_DELETABLE_MESSAGE_TYPES.has(message.type ?? 0)
  );
}

function queueDeletableMessage(message, user, channelId) {
  if (
    !message ||
    !message.id ||
    (message.channel_id && message.channel_id !== channelId) ||
    !isOwnDeletableMessage(message, user) ||
    messageIdSet.has(message.id)
  ) {
    return false;
  }

  messageIdSet.add(message.id);
  messageIds.push(message.id);
  return true;
}

function flattenSearchMessages(body) {
  if (!body || !Array.isArray(body.messages)) {
    return null;
  }

  const messages = [];
  for (const group of body.messages) {
    if (Array.isArray(group)) {
      for (const message of group) {
        if (message && typeof message === "object") {
          messages.push(message);
        }
      }
      continue;
    }

    if (group && typeof group === "object") {
      messages.push(group);
    }
  }

  return messages;
}

async function saveProgress(patch) {
  const data = {
    channelId: patch.channelId ?? "",
    status: patch.status ?? "idle",
    scannedCount: patch.scannedCount ?? 0,
    deletedCount: patch.deletedCount ?? 0,
    failedCount: patch.failedCount ?? 0,
    lastMessageId: patch.lastMessageId ?? "",
    errorMessage: patch.errorMessage ?? "",
    username: patch.username ?? "",
  };
  await chrome.storage.local.set({ progress: data });
  return data;
}

async function getStoredProgress() {
  const result = await chrome.storage.local.get("progress");
  return result.progress || null;
}

function ensurePageBridge() {
  if (pageBridgeReady) {
    return Promise.resolve();
  }
  if (pageBridgeInitPromise) {
    return pageBridgeInitPromise;
  }

  pageBridgeInitPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.onload = () => {
      script.remove();
      pageBridgeReady = true;
      resolve();
    };
    script.onerror = () => {
      pageBridgeInitPromise = null;
      reject(new Error("Could not initialize Discord page bridge."));
    };
    (document.head || document.documentElement).appendChild(script);
  });

  return pageBridgeInitPromise;
}

function bridgeRequest(detail) {
  return new Promise((resolve, reject) => {
    const requestId = String(++bridgeRequestId);
    const timeout = setTimeout(() => {
      document.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
      reject(new Error("Timed out reading Discord session from this tab."));
    }, 15000);

    function onResponse(event) {
      const data = event.detail;
      if (!data || data.requestId !== requestId) {
        return;
      }

      document.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
      clearTimeout(timeout);

      if (data.ok) {
        resolve(data);
        return;
      }

      reject(new Error(data.error || "Bridge request failed."));
    }

    document.addEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
    document.dispatchEvent(
      new CustomEvent(BRIDGE_REQUEST_EVENT, {
        detail: {
          ...detail,
          requestId: requestId,
        },
      })
    );
  });
}

function handleApiResponse(response, options, responseBody) {
  if (response.status === 429) {
    throw new Error("Discord rate limit exceeded. Try again in a moment.");
  }

  if (response.status === 401) {
    throw new Error("Discord session expired or access denied. Refresh the page and try again.");
  }

  if (response.status === 404 && options.method === "DELETE") {
    return { notFound: true };
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(`Discord API forbidden (${response.status}).`);
    }
    throw new Error(`Discord API error (${response.status}).`);
  }

  if (response.status === 204) {
    return null;
  }

  return responseBody;
}

async function discordFetchBridge(path, options = {}) {
  await ensurePageBridge();
  const result = await bridgeRequest({
    action: "apiFetch",
    path: path,
    method: options.method || "GET",
    body: options.body || null,
  });

  const fakeResponse = {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
  };
  return handleApiResponse(fakeResponse, options, result.body);
}

async function discordFetch(path, options = {}) {
  return discordFetchBridge(path, options);
}

async function resolveCurrentUser() {
  if (currentUser) {
    return currentUser;
  }

  await ensurePageBridge();
  const result = await bridgeRequest({ action: "getCurrentUser" });
  currentUser = result.user;
  return currentUser;
}

async function saveScanProgress(channelId, user, lastMessageId) {
  await saveProgress({
    channelId,
    status: "scanning",
    scannedCount: messageIds.length,
    deletedCount: 0,
    failedCount: 0,
    lastMessageId,
    errorMessage: "",
    username: user.username || "",
  });
}

async function scanMessagesWithSearch(route, user) {
  if (!route.guildId || route.isDm) {
    return null;
  }

  let offset = 0;
  let lastMessageId = "";

  try {
    while (true) {
      if (stopped) {
        break;
      }

      while (paused && !stopped) {
        await sleep(200);
      }

      const query = new URLSearchParams({
        author_id: user.id,
        channel_id: route.channelId,
        include_nsfw: "true",
        sort_by: "timestamp",
        sort_order: "desc",
        offset: String(offset),
      });
      const body = await discordFetch(`/guilds/${route.guildId}/messages/search?${query.toString()}`);
      const found = flattenSearchMessages(body);
      if (!found) {
        return null;
      }

      const total = Number(body.total_results);
      if (!found.length && Number.isFinite(total) && total > offset) {
        return null;
      }

      for (const message of found) {
        queueDeletableMessage(message, user, route.channelId);
      }

      if (found.length) {
        lastMessageId = found[found.length - 1].id || lastMessageId;
      }

      await saveScanProgress(route.channelId, user, lastMessageId);

      if (!found.length || (Number.isFinite(total) && offset + SEARCH_PAGE_SIZE >= total)) {
        break;
      }

      offset += SEARCH_PAGE_SIZE;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("session expired")) {
      throw err;
    }
    return null;
  }

  return { lastMessageId, user };
}

async function scanMessagesByHistory(channelId, user) {
  let before = null;
  let lastMessageId = "";

  while (true) {
    if (stopped) {
      break;
    }

    while (paused && !stopped) {
      await sleep(200);
    }

    const query = new URLSearchParams({ limit: "100" });
    if (before) {
      query.set("before", before);
    }

    const batch = await discordFetch(`/channels/${channelId}/messages?${query.toString()}`);
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    for (const message of batch) {
      queueDeletableMessage(message, user, channelId);
    }

    before = batch[batch.length - 1].id;
    lastMessageId = before;

    await saveScanProgress(channelId, user, lastMessageId);

    if (batch.length < 100) {
      break;
    }
  }

  return { lastMessageId, user };
}

async function scanMessages(route) {
  const user = await resolveCurrentUser();
  const searchResult = await scanMessagesWithSearch(route, user);
  if (searchResult || stopped) {
    return searchResult || { lastMessageId: "", user };
  }
  return scanMessagesByHistory(route.channelId, user);
}

async function runScan() {
  stopped = false;
  paused = false;
  messageIds = [];
  messageIdSet = new Set();
  deleteIndex = 0;
  currentUser = null;

  const route = parseDiscordRoute(window.location.pathname);
  if (!route || !route.channelId) {
    await saveProgress({
      status: "error",
      errorMessage: "Open a Discord channel or thread before scanning.",
    });
    return { ok: false, error: "Open a Discord channel or thread before scanning." };
  }
  const channelId = route.channelId;

  scanning = true;

  try {
    await saveProgress({
      channelId,
      status: "scanning",
      scannedCount: 0,
      deletedCount: 0,
      failedCount: 0,
      lastMessageId: "",
      errorMessage: "",
    });

    const { lastMessageId, user } = await scanMessages(route);
    if (stopped) {
      await saveProgress({
        channelId,
        status: "stopped",
        scannedCount: messageIds.length,
        deletedCount: 0,
        failedCount: 0,
        lastMessageId,
        errorMessage: "",
        username: user.username || "",
      });
      return { ok: true, stopped: true, scannedCount: messageIds.length, channelId };
    }

    deleteIndex = 0;

    await saveProgress({
      channelId,
      status: "scanned",
      scannedCount: messageIds.length,
      deletedCount: 0,
      failedCount: 0,
      lastMessageId,
      errorMessage: "",
      username: user.username || "",
    });

    return { ok: true, scannedCount: messageIds.length, channelId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed.";
    const previous = (await getStoredProgress()) || {};
    await saveProgress({
      channelId: previous.channelId || "",
      status: "error",
      scannedCount: previous.scannedCount || 0,
      deletedCount: previous.deletedCount || 0,
      failedCount: previous.failedCount || 0,
      lastMessageId: previous.lastMessageId || "",
      errorMessage: message,
      username: previous.username || "",
    });
    clearSensitiveState();
    return { ok: false, error: message };
  } finally {
    scanning = false;
  }
}

async function runDelete() {
  if (scanning) {
    return { ok: false, error: "Stop scanning before deleting." };
  }

  if (!messageIds.length) {
    return { ok: false, error: "Run scan first." };
  }

  const channelId = parseChannelId(window.location.pathname);
  if (!channelId) {
    return { ok: false, error: "Open a Discord channel or thread before deleting." };
  }

  stopped = false;
  paused = false;
  deleting = true;

  const counts = {
    deleted: 0,
    failed: 0,
    lastMessageId: "",
  };
  const progress = (await getStoredProgress()) || {};
  let progressSave = Promise.resolve();

  function saveDeleteProgress(status) {
    const data = {
      channelId,
      status,
      scannedCount: messageIds.length,
      deletedCount: counts.deleted,
      failedCount: counts.failed,
      lastMessageId: counts.lastMessageId || messageIds[Math.max(0, deleteIndex - 1)] || "",
      errorMessage: "",
      username: progress.username || "",
    };
    progressSave = progressSave
      .catch(() => {})
      .then(() => saveProgress(data));
    return progressSave;
  }

  async function runDeleteWorker() {
    while (deleteIndex < messageIds.length) {
      if (stopped) {
        break;
      }

      while (paused && !stopped) {
        await saveDeleteProgress("paused");
        await sleep(200);
      }

      if (stopped || deleteIndex >= messageIds.length) {
        break;
      }

      const messageId = messageIds[deleteIndex];
      deleteIndex += 1;

      try {
        await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
          method: "DELETE",
        });
        counts.deleted += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("session expired")) {
          throw err;
        }
        counts.failed += 1;
      }

      counts.lastMessageId = messageId;
      saveDeleteProgress("deleting");
    }
  }

  try {
    await saveProgress({
      ...progress,
      channelId,
      status: "deleting",
      scannedCount: messageIds.length,
      deletedCount: counts.deleted,
      failedCount: counts.failed,
      errorMessage: "",
    });

    let fatalError = null;
    const workerCount = Math.min(MAX_DELETE_CONCURRENCY, messageIds.length);
    const workers = Array.from({ length: workerCount }, () =>
      runDeleteWorker().catch((err) => {
        fatalError = fatalError || err;
        stopped = true;
      })
    );
    await Promise.all(workers);
    await progressSave;

    if (fatalError) {
      throw fatalError;
    }

    if (stopped) {
      await saveDeleteProgress("stopped");
      await progressSave;
      return { ok: true, stopped: true, deletedCount: counts.deleted, failedCount: counts.failed };
    }

    await saveDeleteProgress("complete");
    await progressSave;

    clearSensitiveState();

    return { ok: true, deletedCount: counts.deleted, failedCount: counts.failed };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    await saveProgress({
      channelId,
      status: "error",
      scannedCount: messageIds.length,
      deletedCount: counts.deleted,
      failedCount: counts.failed,
      lastMessageId: messageIds[deleteIndex] || "",
      errorMessage: message,
      username: progress.username || "",
    });
    return { ok: false, error: message, deletedCount: counts.deleted, failedCount: counts.failed };
  } finally {
    deleting = false;
  }
}

function getLiveProgress(progress) {
  if (!progress) {
    return progress;
  }

  if (progress.status === "scanning" && !scanning) {
    return {
      ...progress,
      status: messageIds.length ? "stopped" : "idle",
      scannedCount: messageIds.length,
    };
  }

  if ((progress.status === "deleting" || progress.status === "paused") && !deleting) {
    return {
      ...progress,
      status: messageIds.length ? "stopped" : "idle",
      scannedCount: messageIds.length,
    };
  }

  return progress;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message && message.action;

  const handle = async () => {
    switch (action) {
      case "scan":
        return runScan();
      case "delete":
        return runDelete();
      case "pause":
        paused = true;
        return { ok: true, paused: true };
      case "resume":
        paused = false;
        return { ok: true, paused: false };
      case "stop":
        stopped = true;
        paused = false;
        return { ok: true, stopped: true };
      case "getStatus": {
        const progress = getLiveProgress(await getStoredProgress());
        return {
          ok: true,
          progress,
          queueRemaining: Math.max(0, messageIds.length - deleteIndex),
          hasQueue: messageIds.length > 0,
        };
      }
      default:
        return { ok: false, error: "Unknown action." };
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "Unexpected error.",
      });
    });

  return true;
});
