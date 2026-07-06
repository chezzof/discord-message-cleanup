const BRIDGE_REQUEST_EVENT = "discordCleanupBridgeRequest";
const BRIDGE_RESPONSE_EVENT = "discordCleanupBridgeResponse";

let currentUser = null;
let messageIds = [];
let deleteIndex = 0;
let paused = false;
let stopped = false;

let bridgeRequestId = 0;
let pageBridgeReady = false;
let pageBridgeInitPromise = null;

const NON_DELETABLE_MESSAGE_TYPES = new Set([1, 2, 3, 4, 5, 21]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseChannelId(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "channels" || parts.length < 3) {
    return null;
  }

  if (parts[1] === "@me") {
    return parts[2] || null;
  }

  if (parts.length >= 4) {
    return parts[3];
  }

  return parts[2] || null;
}

function clearSensitiveState() {
  currentUser = null;
  messageIds = [];
  deleteIndex = 0;
}

function isOwnDeletableMessage(message, user) {
  return (
    message.author &&
    message.author.id === user.id &&
    !NON_DELETABLE_MESSAGE_TYPES.has(message.type ?? 0)
  );
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

async function scanMessages(channelId) {
  const user = await resolveCurrentUser();
  const ownIds = [];
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
      if (isOwnDeletableMessage(message, user)) {
        ownIds.push(message.id);
      }
    }

    before = batch[batch.length - 1].id;
    lastMessageId = before;

    await saveProgress({
      channelId,
      status: "scanning",
      scannedCount: ownIds.length,
      deletedCount: 0,
      failedCount: 0,
      lastMessageId,
      errorMessage: "",
      username: user.username || "",
    });

    if (batch.length < 100) {
      break;
    }
  }

  return { ownIds, lastMessageId, user };
}

async function runScan() {
  stopped = false;
  paused = false;
  messageIds = [];
  deleteIndex = 0;
  currentUser = null;

  const channelId = parseChannelId(window.location.pathname);
  if (!channelId) {
    await saveProgress({
      status: "error",
      errorMessage: "Open a Discord channel or thread before scanning.",
    });
    return { ok: false, error: "Open a Discord channel or thread before scanning." };
  }

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

    const { ownIds, lastMessageId, user } = await scanMessages(channelId);
    if (stopped) {
      await saveProgress({
        channelId,
        status: "stopped",
        scannedCount: ownIds.length,
        deletedCount: 0,
        failedCount: 0,
        lastMessageId,
        errorMessage: "",
        username: user.username || "",
      });
      return { ok: true, stopped: true };
    }

    messageIds = ownIds;
    deleteIndex = 0;

    await saveProgress({
      channelId,
      status: "scanned",
      scannedCount: ownIds.length,
      deletedCount: 0,
      failedCount: 0,
      lastMessageId,
      errorMessage: "",
      username: user.username || "",
    });

    return { ok: true, scannedCount: ownIds.length, channelId };
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
  }
}

async function runDelete() {
  if (!messageIds.length) {
    return { ok: false, error: "Run scan first." };
  }

  const channelId = parseChannelId(window.location.pathname);
  if (!channelId) {
    return { ok: false, error: "Open a Discord channel or thread before deleting." };
  }

  stopped = false;
  paused = false;

  let deletedCount = 0;
  let failedCount = 0;
  const progress = (await getStoredProgress()) || {};

  try {
    await saveProgress({
      ...progress,
      channelId,
      status: "deleting",
      scannedCount: messageIds.length,
      deletedCount,
      failedCount,
      errorMessage: "",
    });

    while (deleteIndex < messageIds.length) {
      if (stopped) {
        await saveProgress({
          channelId,
          status: "stopped",
          scannedCount: messageIds.length,
          deletedCount,
          failedCount,
          lastMessageId: messageIds[deleteIndex] || "",
          errorMessage: "",
          username: progress.username || "",
        });
        return { ok: true, stopped: true, deletedCount, failedCount };
      }

      while (paused && !stopped) {
        await saveProgress({
          channelId,
          status: "paused",
          scannedCount: messageIds.length,
          deletedCount,
          failedCount,
          lastMessageId: messageIds[deleteIndex] || "",
          errorMessage: "",
          username: progress.username || "",
        });
        await sleep(200);
      }

      const messageId = messageIds[deleteIndex];

      try {
        await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
          method: "DELETE",
        });
        deletedCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("session expired")) {
          throw err;
        }
        failedCount += 1;
      }

      deleteIndex += 1;

      await saveProgress({
        channelId,
        status: "deleting",
        scannedCount: messageIds.length,
        deletedCount,
        failedCount,
        lastMessageId: messageId,
        errorMessage: "",
        username: progress.username || "",
      });
    }

    await saveProgress({
      channelId,
      status: "complete",
      scannedCount: messageIds.length,
      deletedCount,
      failedCount,
      lastMessageId: messageIds[messageIds.length - 1] || "",
      errorMessage: "",
      username: progress.username || "",
    });

    messageIds = [];
    deleteIndex = 0;

    return { ok: true, deletedCount, failedCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    await saveProgress({
      channelId,
      status: "error",
      scannedCount: messageIds.length,
      deletedCount,
      failedCount,
      lastMessageId: messageIds[deleteIndex] || "",
      errorMessage: message,
      username: progress.username || "",
    });
    return { ok: false, error: message, deletedCount, failedCount };
  }
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
        const progress = await getStoredProgress();
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
