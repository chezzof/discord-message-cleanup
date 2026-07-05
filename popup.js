const statusEl = document.getElementById("status");
const channelIdEl = document.getElementById("channelId");
const usernameEl = document.getElementById("username");
const scannedCountEl = document.getElementById("scannedCount");
const deletedCountEl = document.getElementById("deletedCount");
const failedCountEl = document.getElementById("failedCount");
const errorMessageEl = document.getElementById("errorMessage");

const scanBtn = document.getElementById("scanBtn");
const deleteBtn = document.getElementById("deleteBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const stopBtn = document.getElementById("stopBtn");

let activeTabId = null;
let pollTimer = null;

function setError(message) {
  if (!message) {
    errorMessageEl.textContent = "";
    errorMessageEl.classList.add("hidden");
    return;
  }
  errorMessageEl.textContent = message;
  errorMessageEl.classList.remove("hidden");
}

function updateUi(progress) {
  const data = progress || {
    status: "idle",
    channelId: "",
    username: "",
    scannedCount: 0,
    deletedCount: 0,
    failedCount: 0,
    errorMessage: "",
  };

  const status = data.status || "idle";
  statusEl.textContent = status;
  statusEl.dataset.state = status;
  channelIdEl.textContent = data.channelId || "-";
  usernameEl.textContent = data.username || "-";
  scannedCountEl.textContent = String(data.scannedCount ?? 0);
  deletedCountEl.textContent = String(data.deletedCount ?? 0);
  failedCountEl.textContent = String(data.failedCount ?? 0);
  setError(data.errorMessage || "");

  const scanned = Number(data.scannedCount || 0);
  const isBusy = status === "scanning" || status === "deleting" || status === "paused";

  scanBtn.disabled = isBusy;
  deleteBtn.disabled = !(status === "scanned" && scanned > 0);
  deleteBtn.textContent = `Delete ${scanned} message${scanned === 1 ? "" : "s"}`;

  pauseBtn.disabled = status !== "deleting";
  resumeBtn.disabled = status !== "paused";
  stopBtn.disabled = !(status === "scanning" || status === "deleting" || status === "paused");
}

async function getActiveDiscordTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://discord.com/")) {
    throw new Error("Open https://discord.com in the active tab first.");
  }
  activeTabId = tab.id;
  return tab;
}

function sendToContent(action) {
  return new Promise((resolve, reject) => {
    if (!activeTabId) {
      reject(new Error("No active Discord tab."));
      return;
    }

    chrome.tabs.sendMessage(activeTabId, { action }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Reload the Discord tab, then try again."));
        return;
      }
      resolve(response);
    });
  });
}

async function refreshProgress() {
  const stored = await chrome.storage.local.get("progress");
  updateUi(stored.progress);
}

async function startPolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(refreshProgress, 500);
}

function stopPolling() {
  if (!pollTimer) {
    return;
  }
  clearInterval(pollTimer);
  pollTimer = null;
}

scanBtn.addEventListener("click", async () => {
  try {
    await getActiveDiscordTab();
    startPolling();
    const result = await sendToContent("scan");
    if (!result || !result.ok) {
      setError((result && result.error) || "Scan failed.");
    }
    await refreshProgress();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Scan failed.");
  }
});

deleteBtn.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("progress");
  const count = stored.progress ? stored.progress.scannedCount : 0;
  const confirmed = window.confirm(
    `Delete ${count} of your messages in this chat for everyone? This cannot be undone.`
  );
  if (!confirmed) {
    return;
  }

  try {
    await getActiveDiscordTab();
    startPolling();
    const result = await sendToContent("delete");
    if (!result || !result.ok) {
      setError((result && result.error) || "Delete failed.");
    }
    await refreshProgress();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Delete failed.");
  }
});

pauseBtn.addEventListener("click", async () => {
  try {
    await getActiveDiscordTab();
    await sendToContent("pause");
    await refreshProgress();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Pause failed.");
  }
});

resumeBtn.addEventListener("click", async () => {
  try {
    await getActiveDiscordTab();
    await sendToContent("resume");
    await refreshProgress();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Resume failed.");
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await getActiveDiscordTab();
    await sendToContent("stop");
    await refreshProgress();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Stop failed.");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.progress) {
    updateUi(changes.progress.newValue);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await getActiveDiscordTab();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Open Discord first.");
  }
  await refreshProgress();
});

window.addEventListener("unload", stopPolling);
