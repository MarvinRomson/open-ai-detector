"use strict";

// Server URL configurable via extension options (chrome.storage.sync: serverUrl)
async function getEndpoints() {
  try {
    const { serverUrl } = await chrome.storage.sync.get({ serverUrl: "http://localhost:8000" });
    const base = (serverUrl || "http://localhost:8000").replace(/\/+$/, "");
    return {
      SCORE_ENDPOINT: `${base}/score`,
      REWRITE_ENDPOINT: `${base}/rewrite`,
    };
  } catch {
    const base = "http://localhost:8000";
    return {
      SCORE_ENDPOINT: `${base}/score`,
      REWRITE_ENDPOINT: `${base}/rewrite`,
    };
  }
}

// Utility: chunk an array into fixed-size batches
function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) {
    res.push(arr.slice(i, i + size));
  }
  return res;
}

// Send a message to a tab and return a Promise
function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        return reject(err);
      }
      resolve(response);
    });
  });
}

// Ensure the content script is present on a tab (inject if needed)
async function ensureContentScript(tab) {
  if (!tab || !tab.id) return;
  try {
    // Try a quick ping first
    await sendMessageToTab(tab.id, { type: "PING" });
    return;
  } catch (_e) {
    // No receiving end, attempt to inject the content script
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ["content.js"],
      });
    } catch (e) {
      console.warn("Failed to inject content script:", e);
      throw e;
    }
  }
}

async function scanTab(tab) {
  try {
    if (!tab || !tab.id || !tab.url) return;
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;
    await ensureContentScript(tab);
    await sendMessageToTab(tab.id, { type: "SCAN_ONLY" });
    // Badge feedback
    try {
      chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
      chrome.action.setBadgeText({ text: "RUN", tabId: tab.id });
      setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 2000);
    } catch {}
  } catch (e) {
    console.warn("Auto-scan failed for tab", tab?.id, tab?.url, e);
  }
}

// Call the FastAPI /score endpoint with blocks from one tab, then forward scores back to that tab
async function scoreBlocksForTab(tabId, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return;

  const CHUNK_SIZE = 200; // Avoid very large payloads
  let allScores = [];
  const { SCORE_ENDPOINT } = await getEndpoints();

  for (const part of chunk(blocks, CHUNK_SIZE)) {
    const resp = await fetch(SCORE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: part }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Server responded ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    if (data && Array.isArray(data.scores)) {
      allScores = allScores.concat(data.scores);
    }
  }

  // Send scores back to the content script to apply highlights
  await sendMessageToTab(tabId, {
    type: "APPLY_SCORES",
    scores: allScores,
    scale: "1-100",
  }).catch((e) => console.warn("Failed to deliver scores to tab", tabId, e));
}

// Listen for content script messages carrying text blocks
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BLOCKS_FOR_SCORING") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse?.({ ok: false, error: "No sender tab id" });
      return; // do not return true (not async)
    }
    (async () => {
      try {
        await scoreBlocksForTab(tabId, message.blocks || []);
        sendResponse?.({ ok: true });
      } catch (e) {
        console.error("Scoring failed:", e);
        sendResponse?.({ ok: false, error: String(e) });
      }
    })();
    return true; // Keep the messaging channel open for async response
  }

  if (message?.type === "REQUEST_REWRITE") {
    (async () => {
      try {
        const text = message.text || "";
        const { REWRITE_ENDPOINT } = await getEndpoints();
        const resp = await fetch(REWRITE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!resp.ok) {
          const t = await resp.text().catch(() => "");
          throw new Error(`Server responded ${resp.status}: ${t}`);
        }
        const data = await resp.json();
        sendResponse?.({ ok: true, text: data?.text ?? "" });
      } catch (e) {
        console.error("Rewrite failed:", e);
        sendResponse?.({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "PING") {
    sendResponse?.({ ok: true, pong: true });
    return; // synchronous
  }
});

// Toolbar button: trigger a rescan on all open tabs
chrome.action.onClicked.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      // Skip internal Chrome/extension pages and tabs without URLs
      if (!tab.id || !tab.url) continue;
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;

      try {
        await ensureContentScript(tab);
        await sendMessageToTab(tab.id, { type: "SCAN_ONLY" });
      } catch (e) {
        console.warn("Failed to scan tab", tab.id, tab.url, e);
      }
    }
  } catch (e) {
    console.error("Action click handling failed:", e);
  }
});

// Auto-scan on page load/activation, and once on install
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    scanTab(tab);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    scanTab(tab);
  } catch (e) {
    console.warn("onActivated get tab failed:", e);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log("Text Score Highlighter installed.");
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active) {
      await scanTab(active);
    }
  } catch (e) {
    console.warn("onInstalled scan failed:", e);
  }
});
