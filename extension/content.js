"use strict";

// Configuration
const MIN_CHARS = 30;         // ignore very short text blocks
const MAX_CHARS = 5000;       // skip extremely large blocks
const MAX_BLOCKS = 1000;      // safety cap per page
const CANDIDATE_SELECTOR = "p, div, section, article, li, blockquote";

// Settings defaults and helpers
const SETTINGS_DEFAULTS = {
  showRewrite: true,
  minHighlightScore: 1,
  minWords: 0,
  enabled: true
};

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(SETTINGS_DEFAULTS, (res) => resolve(res || SETTINGS_DEFAULTS));
    } catch {
      resolve(SETTINGS_DEFAULTS);
    }
  });
}

function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

// State for the current page
let elementMap = new Map();   // id -> Element
let idCounter = 0;
let selectedIds = new Set();
let selectedTextById = new Map();
window.__extEnabled = true;

// Visibility check
function isElementVisible(el) {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }
  return true;
}

// Generate or reuse a stable id for an element during a scan pass
function generateExtId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return "ext-" + crypto.randomUUID();
    }
  } catch {}
  return "ext-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function ensureIdForElement(el) {
  if (el.dataset && el.dataset.extScoreId) {
    return el.dataset.extScoreId;
  }
  const id = generateExtId();
  if (el.dataset) {
    el.dataset.extScoreId = id;
  }
  elementMap.set(id, el);
  return id;
}

function getText(el) {
  // innerText respects visibility and layout, better than textContent here
  return (el.innerText || "").replace(/\s+/g, " ").trim();
}

// Return only the element's own direct text (exclude descendant elements' text)
function getOwnText(el) {
  const parts = [];
  for (const node of el.childNodes || []) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue || "");
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Replace only the element's own direct text nodes with newText (do not touch children)
function setOwnText(el, newText) {
  try {
    const toRemove = [];
    for (const node of el.childNodes || []) {
      if (node.nodeType === Node.TEXT_NODE) {
        toRemove.push(node);
      }
    }
    for (const n of toRemove) el.removeChild(n);
    const tn = document.createTextNode(newText || "");
    el.insertBefore(tn, el.firstChild || null);
  } catch (_e) {
    // Fallback: this may affect descendants, used only if DOM ops fail
    el.innerText = newText || "";
  }
}

/**
 * Return text for scoring:
 * - Includes this element's own text nodes
 * - Includes descendant text EXCEPT when the descendant is a P or DIV (treated as separate containers)
 * - Skips script/style/noscript/template
 */
function getScoringText(el) {
  const EXCLUDE_TAGS = new Set(["P", "DIV"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const out = [];

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = (node.nodeValue || "").trim();
      if (v) out.push(v);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return;
      // Skip any injected UI (select buttons, toolbars, rewrite panels)
      if (node !== el && isInjectedNode(node)) return;
      // If this is a descendant container (P/DIV), skip its subtree
      if (node !== el && EXCLUDE_TAGS.has(tag)) return;
      for (const child of node.childNodes || []) walk(child);
    }
  }

  for (const child of el.childNodes || []) walk(child);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Simple local rewrite heuristic (keep it client-side)
function localRewrite(text) {
  const raw = (text || "").trim();
  if (!raw) return raw;
  let s = raw.replace(/\s+/g, " ");
  s = s.replace(/\s+([,.;:!?])/g, "$1");             // remove space before punctuation
  s = s.replace(/([,.;:!?])(?=[^\s"\')\]])/g, "$1 "); // ensure one space after punctuation
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase()); // capitalize sentence starts
  return s;
}

function collectBlocks(minWords) {
  elementMap = new Map();

  const nodes = document.querySelectorAll(CANDIDATE_SELECTOR);
  const blocks = [];
  for (const el of nodes) {
    if (isInjectedNode(el)) continue;
    if (!isElementVisible(el)) continue;
    const text = getScoringText(el);
    if (text.length < MIN_CHARS) continue;
    if (text.length > MAX_CHARS) continue;

    const id = ensureIdForElement(el);
    if ((minWords || 0) > 0 && countWords(text) < minWords) continue;
    blocks.push({ id, text });
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks;
}

function removeChildIfExists(el, selector) {
  try {
    const node = el.querySelector(selector);
    if (node) node.remove();
  } catch {
    // ignore
  }
}

// Returns true if the element is part of the extension's injected UI
function isInjectedNode(el) {
  try {
    if (!el || !el.classList) return false;
    if (el.classList.contains("ext-run-panel")) return true;
    if (el.classList.contains("ext-select-toggle")) return true;
    if (el.classList.contains("ext-score-toolbar")) return true;
    if (el.classList.contains("ext-rewrite-panel")) return true;
    if (el.closest(".ext-run-panel, .ext-select-toggle, .ext-score-toolbar, .ext-rewrite-panel")) return true;
  } catch {}
  return false;
}

// Remove ALL injected UI across the document (used when turning Off)
function purgeAllInjectedUI() {
  try {
    // Remove per-element buttons/panels
    document.querySelectorAll(".ext-select-toggle, .ext-score-toolbar, .ext-rewrite-panel").forEach((n) => n.remove());

    // Clear classes and inline styles from any elements we touched
    document.querySelectorAll(".ext-selected-outline, .ext-score-highlight").forEach((el) => {
      el.classList.remove("ext-selected-outline");
      el.classList.remove("ext-score-highlight");
      try {
        if (el.style) {
          el.style.backgroundColor = "";
          el.style.outline = "";
        }
        if (el.dataset) {
          delete el.dataset.extSelected;
          delete el.dataset.extScore;
          delete el.dataset.extScoreApplied;
        }
      } catch {}
    });
  } catch {}
}

function clearHighlight(el) {
  if (!el || !(el instanceof Element)) return;
  el.classList.remove("ext-score-highlight");
  el.classList.remove("ext-score-host");
  // Remove toolbar and any open panel
  removeChildIfExists(el, ":scope > .ext-score-toolbar");
  removeChildIfExists(el, ":scope > .ext-rewrite-panel");

  if (el.style) {
    el.style.backgroundColor = "";
    el.style.outline = "";
  }
  if (el.dataset) {
    delete el.dataset.extScore;
    delete el.dataset.extScoreApplied;
  }
}

function colorForScore(score) {
  // New mapping:
  // 0 => green (hue 120), 50 => yellow (hue 60), 100 => red (hue 0)
  // For scores > 80, increase red intensity by raising alpha.
  const sNum = Number(score);
  const s = Number.isFinite(sNum) ? Math.max(0, Math.min(100, sNum)) : 0;
  const hue = Math.round(120 - (s * 1.2)); // 0..100 => 120..0
  let alpha = 0.35;
  if (s > 80) {
    const t80 = (s - 80) / 20; // 0..1
    alpha = 0.35 + 0.35 * t80; // up to 0.70 at 100
  }
  const fill = `hsla(${hue}, 85%, 60%, ${alpha})`;  // translucent background, more intense past 80
  const outline = `hsl(${hue}, 85%, 35%)`;          // darker outline
  return { fill, outline };
}

function ensureToolbar(el) {
  // Anchor absolute toolbar reliably
  el.classList.add("ext-score-host");
  // Check if toolbar already exists
  let toolbar = null;
  try {
    toolbar = el.querySelector(":scope > .ext-score-toolbar");
  } catch {
    // Older engines without :scope support (Chrome supports it, but just in case)
    toolbar = el.querySelector(".ext-score-toolbar");
  }
  if (toolbar) return toolbar;

  toolbar = document.createElement("div");
  toolbar.className = "ext-score-toolbar";
  toolbar.dataset.extInjected = "1";

  const rewriteBtn = document.createElement("button");
  rewriteBtn.className = "ext-score-rewrite-btn";
  rewriteBtn.type = "button";
  rewriteBtn.textContent = "Rewrite";
  rewriteBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openRewritePanel(el, rewriteBtn);
  });

  toolbar.appendChild(rewriteBtn);
  el.appendChild(toolbar);
  return toolbar;
}

function ensureSelectToggle(el) {
  // Anchor for absolute toggle
  el.classList.add("ext-score-host");
  let btn = null;
  try {
    btn = el.querySelector(":scope > .ext-select-toggle");
  } catch {
    btn = el.querySelector(".ext-select-toggle");
  }
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ext-select-toggle";
    btn.dataset.extInjected = "1";
    btn.textContent = "Select";
    el.appendChild(btn);
  }

  const applyVisual = (selected) => {
    if (selected) {
      el.classList.add("ext-selected-outline");
      btn.classList.add("ext-selected");
      btn.textContent = "Selected";
      el.dataset.extSelected = "1";
    } else {
      el.classList.remove("ext-selected-outline");
      btn.classList.remove("ext-selected");
      btn.textContent = "Select";
      delete el.dataset.extSelected;
    }
  };

  btn.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const id = el.dataset.extScoreId || ensureIdForElement(el);
    const selected = !selectedIds.has(id);
    if (selected) {
      selectedIds.add(id);
      try {
        const t = getScoringText(el);
        if (t) selectedTextById.set(id, t);
      } catch {}
    } else {
      selectedIds.delete(id);
      selectedTextById.delete(id);
    }
    applyVisual(selected);
    updateRunPanelCount();
  };

  // initialize button state based on existing selection
  const id = el.dataset.extScoreId || ensureIdForElement(el);
  const isSelected = selectedIds.has(id);
  applyVisual(isSelected);

  return btn;
}

function ensureRunPanel() {
  let panel = document.querySelector(".ext-run-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "ext-run-panel";
    panel.dataset.extInjected = "1";

    // On/Off toggle
    const toggle = document.createElement("button");
    toggle.className = "ext-onoff-button";
    toggle.type = "button";
    toggle.textContent = (window.__extEnabled === false) ? "Off" : "On";
    toggle.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      const newEnabled = !(window.__extEnabled === true);
      await applyEnabledState(newEnabled);
      // Update UI after apply
      const p = document.querySelector(".ext-run-panel");
      if (p) {
        const t = p.querySelector(".ext-onoff-button");
        if (t) t.textContent = (window.__extEnabled === false) ? "Off" : "On";
        updateRunPanelEnabledUI();
      }
    };

    const count = document.createElement("span");
    count.className = "ext-run-count";
    count.textContent = "0 selected";

    const runBtn = document.createElement("button");
    runBtn.className = "ext-run-button";
    runBtn.type = "button";
    runBtn.textContent = "Run scoring";
    runBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); runScoring(); };

    const clearBtn = document.createElement("button");
    clearBtn.className = "ext-clear-button";
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); clearSelection(); };

    panel.appendChild(toggle);
    panel.appendChild(count);
    panel.appendChild(runBtn);
    panel.appendChild(clearBtn);
    document.body.appendChild(panel);
  }
  // Ensure fixed bottom-right placement with inline !important styles to avoid site overrides
  try {
    const setImp = (prop, value) => panel.style.setProperty(prop, value, "important");
    setImp("position", "fixed");
    setImp("bottom", "16px");
    setImp("right", "16px");
    setImp("left", "auto");
    setImp("top", "auto");
    setImp("z-index", "2147483647");
    setImp("display", "flex");
    setImp("align-items", "center");
    setImp("gap", "8px");
    setImp("background", "rgba(255,255,255,0.95)");
    setImp("border", "1px solid rgba(0,0,0,0.15)");
    setImp("border-radius", "10px");
    setImp("padding", "8px 10px");
    setImp("box-shadow", "0 4px 16px rgba(0,0,0,0.2)");
    setImp("font", "13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif");
    setImp("color", "#111");
    setImp("max-width", "90vw");
    setImp("width", "max-content");
    setImp("pointer-events", "auto");
  } catch {}
  updateRunPanelEnabledUI();
  updateRunPanelCount();
  return panel;
}


function updateRunPanelCount() {
  const panel = document.querySelector(".ext-run-panel");
  if (!panel) return;
  const countEl = panel.querySelector(".ext-run-count");
  if (countEl) {
    const n = selectedIds.size;
    countEl.textContent = `${n} selected`;
  }
}

function clearSelection() {
  selectedIds.clear();
  selectedTextById.clear();
  // remove selected visuals and toggles state
  for (const [, el] of elementMap) {
    el.classList.remove("ext-selected-outline");
    if (el.dataset) delete el.dataset.extSelected;
    try {
      const btn = el.querySelector(":scope > .ext-select-toggle");
      if (btn) btn.classList.remove("ext-selected");
    } catch {}
  }
  updateRunPanelCount();
}

function runScoring() {
  if (selectedIds.size === 0) return;
  window.__extInRunScoring = true;
  const blocks = [];
  for (const id of Array.from(selectedIds)) {
    let text = selectedTextById.get(id);
    if (!text) {
      const el = elementMap.get(id) || document.querySelector(`[data-ext-score-id="${CSS.escape(id)}"]`);
      if (el) text = getScoringText(el);
    }
    if (!text) continue;
    blocks.push({ id, text });
  }
  if (blocks.length === 0) { window.__extInRunScoring = false; return; }
  chrome.runtime.sendMessage({ type: "BLOCKS_FOR_SCORING", blocks }, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn("Scoring send error:", err);
    } else if (resp && resp.ok === false) {
      console.warn("Scoring request reported error:", resp.error);
    }
    // Auto-unselect everything after a run
    clearSelection();
    window.__extInRunScoring = false;
  });
}

async function scanCandidates() {
  // Clear previous highlights and UI before a new pass
  for (const [, el] of elementMap) {
    el.classList.remove("ext-score-highlight");
    el.style.backgroundColor = "";
    el.style.outline = "";
    removeChildIfExists(el, ":scope > .ext-score-toolbar");
    removeChildIfExists(el, ":scope > .ext-rewrite-panel");
  }
  const settings = await getSettings();
  window.__extLastSettings = settings;
  window.__extEnabled = (settings.enabled !== false);

  // Always ensure the run panel (for showing On/Off), but hide actions if disabled
  ensureRunPanel();

  if (!window.__extEnabled) {
    // Do not build select buttons or run scans when disabled
    return;
  }

  const blocks = collectBlocks(settings.minWords || 0);
  // Add select toggles to each candidate
  for (const { id } of blocks) {
    const el = elementMap.get(id);
    if (!el) continue;
    ensureSelectToggle(el);
  }
}

function openRewritePanel(el, rewriteBtn) {
  // Remove any existing panel
  removeChildIfExists(el, ":scope > .ext-rewrite-panel");

  const panel = document.createElement("div");
  panel.className = "ext-rewrite-panel";
  panel.dataset.extInjected = "1";
  const header = document.createElement("h4");
  header.textContent = "Rewrite suggestion";
  const textarea = document.createElement("textarea");
  textarea.className = "ext-rewrite-textarea";
  textarea.placeholder = "Fetching suggestion...";
  textarea.disabled = true;

  const actions = document.createElement("div");
  actions.className = "ext-rewrite-actions";
  const applyBtn = document.createElement("button");
  applyBtn.className = "ext-rewrite-apply";
  applyBtn.type = "button";
  applyBtn.textContent = "Apply";
  applyBtn.disabled = true;

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "ext-rewrite-cancel";
  cancelBtn.type = "button";
  cancelBtn.textContent = "Close";

  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);

  panel.appendChild(header);
  panel.appendChild(textarea);
  panel.appendChild(actions);
  el.appendChild(panel);

  const originalText = getOwnText(el);
  // Request rewrite from background/server
  try {
    const suggestion = localRewrite(originalText);
    textarea.value = String(suggestion);
    textarea.disabled = false;
    applyBtn.disabled = false;
  } catch (e) {
    textarea.value = `Rewrite failed: ${String(e)}`;
    textarea.disabled = true;
    applyBtn.disabled = true;
  }

  cancelBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    panel.remove();
  });

  applyBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      // Replace only the element's own direct text (keep child elements intact)
      setOwnText(el, textarea.value || "");
      panel.remove();
      // Re-scan and re-score to update highlighting
      setTimeout(scanAndRequestScores, 50);
    } catch (e2) {
      console.warn("Failed to apply rewrite:", e2);
    }
  });
}

function applyHighlight(el, score) {
  if (!el) return;
  const { fill, outline } = colorForScore(score);
  el.classList.add("ext-score-highlight");
  el.style.backgroundColor = fill;
  el.style.outline = `2px solid ${outline}`;
  if (el.dataset) {
    el.dataset.extScore = String(score);
    el.dataset.extScoreApplied = "1";
  }
  try {
    const numeric = typeof score === "number" ? score.toFixed(2) : String(score);
    el.title = `[AI gen probability] ${numeric}`;
  } catch {
    // ignore
  }

  // Ensure a toolbar for actions (e.g., Rewrite) if enabled
  try {
    const s = (window.__extLastSettings || {});
    if (s.showRewrite !== false) {
      ensureToolbar(el);
    }
  } catch {
    ensureToolbar(el);
  }
}

async function scanAndRequestScores() {
  try {
    if (window.__extInRunScoring) return;
    await scanCandidates();
  } catch (e) {
    console.error("scanAndRequestScores failed:", e);
  }
}

function applyScores(scores) {
  if (!Array.isArray(scores)) return;
  const s = (window.__extLastSettings || { minHighlightScore: 1 });
  const threshold = Number.isFinite(s.minHighlightScore) ? s.minHighlightScore : 1;
  for (const item of scores) {
    const id = item?.id;
    const score = item?.score;
    if (!id || typeof score !== "number" || !Number.isFinite(score) || score < threshold) continue;
    const el = elementMap.get(id) || document.querySelector(`[data-ext-score-id="${CSS.escape(id)}"]`);
    if (!el) continue;
    applyHighlight(el, score);
  }
}

// Listen for background messages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    // When disabled, ignore all except PING
    if (message?.type !== "PING" && window.__extEnabled === false) {
      sendResponse?.({ ok: true });
      return; // no-op
    }
    if (message?.type === "PING") {
      sendResponse?.({ ok: true, pong: true });
      return; // sync
    }

    if (message?.type === "SCAN_ONLY") {
      scanAndRequestScores();
      sendResponse?.({ ok: true });
      return; // sync
    }

    if (message?.type === "SCAN_AND_REQUEST_SCORES") {
      scanAndRequestScores();
      sendResponse?.({ ok: true });
      return; // sync
    }

    if (message?.type === "APPLY_SCORES") {
      applyScores(message.scores || []);
      sendResponse?.({ ok: true });
      return; // sync
    }
  } catch (e) {
    console.warn("content.js message handler error:", e);
    sendResponse?.({ ok: false, error: String(e) });
  }
});

// Dynamic updates for infinite scroll, popups, and DOM changes
function debounce(fn, delay = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function startDynamicWatch() {
  if (window.__extDynamicWatchStarted) return;
  window.__extDynamicWatchStarted = true;

  const debouncedScan = debounce(() => {
    try {
      if (window.__extInRunScoring) return;
      if (window.__extEnabled === false) return;
      scanAndRequestScores();
    } catch (e) {
      console.warn("debounced scan failed:", e);
    }
  }, 400);

  window.__extDebouncedScan = debouncedScan;

  // Observe DOM changes (popups, dynamic inserts)
  try {
    const obs = new MutationObserver(() => debouncedScan());
    window.__extDomObserver = obs;
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true });
    } else {
      // Fallback if body not ready yet
      window.addEventListener("DOMContentLoaded", () => {
        try {
          obs.observe(document.body, { childList: true, subtree: true });
        } catch {}
      }, { once: true });
    }
  } catch (e) {
    console.warn("MutationObserver unavailable:", e);
  }

  // React to scroll/resize/hash changes (infinite scroll, route changes)
  window.addEventListener("scroll", window.__extDebouncedScan, { passive: true });
  window.addEventListener("resize", window.__extDebouncedScan);
  window.addEventListener("hashchange", window.__extDebouncedScan);
  window.addEventListener("popstate", window.__extDebouncedScan);
}

function stopDynamicWatch() {
  try {
    if (window.__extDomObserver && typeof window.__extDomObserver.disconnect === "function") {
      window.__extDomObserver.disconnect();
    }
  } catch {}
  try { window.removeEventListener("scroll", window.__extDebouncedScan); } catch {}
  try { window.removeEventListener("resize", window.__extDebouncedScan); } catch {}
  try { window.removeEventListener("hashchange", window.__extDebouncedScan); } catch {}
  try { window.removeEventListener("popstate", window.__extDebouncedScan); } catch {}
  window.__extDynamicWatchStarted = false;
}

// Auto-scan on initial load/ready + enable dynamic watching
(function init() {
  const kick = () => {
    setTimeout(() => {
      scanAndRequestScores();
      startDynamicWatch();
    }, 600);
  };
  if (document.readyState === "complete" || document.readyState === "interactive") {
    kick();
  } else {
    window.addEventListener("DOMContentLoaded", kick, { once: true });
  }
})();
 
// Update UI of run panel based on enabled state (show only On/Off when disabled)
function updateRunPanelEnabledUI() {
  const panel = document.querySelector(".ext-run-panel");
  if (!panel) return;
  const toggle = panel.querySelector(".ext-onoff-button");
  const count = panel.querySelector(".ext-run-count");
  const runBtn = panel.querySelector(".ext-run-button");
  const clearBtn = panel.querySelector(".ext-clear-button");
  const off = (window.__extEnabled === false);

  if (toggle) toggle.textContent = off ? "Off" : "On";
  if (count) count.style.display = off ? "none" : "";
  if (runBtn) runBtn.style.display = off ? "none" : "";
  if (clearBtn) clearBtn.style.display = off ? "none" : "";
}

// Apply enabled/disabled state: persist, start/stop watchers, clear UI if disabling
async function applyEnabledState(newEnabled) {
  window.__extEnabled = !!newEnabled;
  try {
    await new Promise((resolve) => {
      try {
        chrome.storage.sync.set({ enabled: window.__extEnabled }, () => resolve());
      } catch { resolve(); }
    });
  } catch {}

  updateRunPanelEnabledUI();

  if (window.__extEnabled === false) {
    // Stop watching, clear UI (regardless of previous scans)
    stopDynamicWatch();
    clearSelection();
    purgeAllInjectedUI();
  } else {
    // Re-enable scanning and immediately rebuild Select buttons
    // Start fresh: clear any stale UI/classes first
    clearSelection();
    purgeAllInjectedUI();
    stopDynamicWatch();          // 👈 ensure reset before re-start
    startDynamicWatch();
    // Run candidate scan immediately (don’t wait for messages/watchers)
    await scanCandidates();
    setTimeout(scanCandidates, 300);  // extra fallback
    // Schedule follow-up passes in case the DOM shifts or late content arrives
    try {
      setTimeout(() => { if (window.__extEnabled) scanCandidates(); }, 150);
      setTimeout(() => { if (window.__extEnabled) scanCandidates(); }, 500);
    } catch {}
  }
}
