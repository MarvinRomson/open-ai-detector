"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("form");
  const serverUrl = document.getElementById("serverUrl");
  const showRewrite = document.getElementById("showRewrite");
  const minHighlightScore = document.getElementById("minHighlightScore");
  const minWords = document.getElementById("minWords");
  const resetBtn = document.getElementById("reset");
  const status = document.getElementById("status");

  const DEFAULTS = {
    serverUrl: "http://localhost:8000",
    showRewrite: true,
    minHighlightScore: 1,
    minWords: 0
  };

  try {
    const saved = await chrome.storage.sync.get(DEFAULTS);
    serverUrl.value = saved.serverUrl || DEFAULTS.serverUrl;
    showRewrite.checked = !!saved.showRewrite;
    minHighlightScore.value = Number.isFinite(saved.minHighlightScore) ? saved.minHighlightScore : DEFAULTS.minHighlightScore;
    minWords.value = Number.isFinite(saved.minWords) ? saved.minWords : DEFAULTS.minWords;
  } catch (e) {
    // Fallback to defaults if storage is unavailable
    serverUrl.value = DEFAULTS.serverUrl;
    showRewrite.checked = DEFAULTS.showRewrite;
    minHighlightScore.value = DEFAULTS.minHighlightScore;
    minWords.value = DEFAULTS.minWords;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const minScore = Math.max(1, Math.min(100, parseInt(minHighlightScore.value || "1", 10)));
    const minW = Math.max(0, parseInt(minWords.value || "0", 10));
    const data = {
      serverUrl: (serverUrl.value || "").trim() || DEFAULTS.serverUrl,
      showRewrite: !!showRewrite.checked,
      minHighlightScore: minScore,
      minWords: minW
    };
    try {
      await chrome.storage.sync.set(data);
      status.textContent = "Saved.";
      // Optionally trigger a rescan on the active tab
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active && active.id) {
          chrome.tabs.sendMessage(active.id, { type: "SCAN_ONLY" }, () => void 0);
        }
      } catch {}
    } catch (e) {
      status.textContent = "Failed to save settings.";
    } finally {
      setTimeout(() => (status.textContent = ""), 1500);
    }
  });

  resetBtn.addEventListener("click", async () => {
    try {
      await chrome.storage.sync.set(DEFAULTS);
      serverUrl.value = DEFAULTS.serverUrl;
      showRewrite.checked = DEFAULTS.showRewrite;
      minHighlightScore.value = DEFAULTS.minHighlightScore;
      minWords.value = DEFAULTS.minWords;
      status.textContent = "Reset to defaults.";
      // Optionally trigger a rescan on the active tab
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active && active.id) {
          chrome.tabs.sendMessage(active.id, { type: "SCAN_ONLY" }, () => void 0);
        }
      } catch {}
    } catch {
      status.textContent = "Failed to reset.";
    } finally {
      setTimeout(() => (status.textContent = ""), 1500);
    }
  });
});
