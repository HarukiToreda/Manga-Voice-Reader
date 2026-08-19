// Haruki's Manga Voice Reader - background service worker
// Seeds default settings on install, captures viewport screenshots, and
// relays them to the offscreen document for OCR (PaddleOCR via ONNX Runtime
// Web — see offscreen.js for why OCR can't run directly in this service
// worker: onnxruntime-web's wasm backend needs dynamic import(), which
// Chrome disallows inside ServiceWorkerGlobalScope).

const DEFAULT_SETTINGS = {
  enabled: true,
  direction: 'rtl',
  ttsEngine: 'piper', // 'piper' or 'kokoro'
  piperVoiceId: 'en_US-hfc_female-medium',
  kokoroVoiceId: 'af_heart',
  autoScrollSpeed: 140,
  volume: 100,
};

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  const existing = await chrome.storage.sync.get('mvrSettings');
  if (!existing.mvrSettings) {
    await chrome.storage.sync.set({ mvrSettings: DEFAULT_SETTINGS });
  }
});

// ---------------- persistent per-site auto-start ----------------
// "Turn it on for a site" has to survive reloads and navigation, not just
// last as long as the current tab's live content-script instance — that
// instance's whole state (including STATE.enabled) lives in one injection's
// closure and dies with the page. Tracked as a plain list of origins in
// chrome.storage.sync (small, syncs across the user's own Chrome installs
// the same way mvrSettings already does).

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return null;
  }
}

async function getEnabledOrigins() {
  const { mvrEnabledOrigins } = await chrome.storage.sync.get('mvrEnabledOrigins');
  return Array.isArray(mvrEnabledOrigins) ? mvrEnabledOrigins : [];
}

async function setOriginEnabled(origin, enabled) {
  if (!origin) return;
  const origins = await getEnabledOrigins();
  const next = enabled ? Array.from(new Set([...origins, origin])) : origins.filter((o) => o !== origin);
  await chrome.storage.sync.set({ mvrEnabledOrigins: next });
}

// Mirrors popup.js's startReading() — injecting on-demand rather than via a
// manifest-declared content script keeps the extension from running on
// every page the user visits, only ones actually turned on.
async function startReadingInTab(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib-shared/common-words.js', 'lib-shared/reading-order.js', 'content.js'],
    });
    const { mvrSettings } = await chrome.storage.sync.get('mvrSettings');
    await chrome.tabs.sendMessage(tabId, {
      type: 'MVR_INIT',
      settings: { ...DEFAULT_SETTINGS, ...(mvrSettings || {}), enabled: true },
    });
  } catch (e) {
    // Page doesn't allow content scripts at all (chrome://, the Web Store,
    // etc.) — nothing to do, same as popup.js's own try/catch around this.
  }
}

// Auto-resumes reading on any page whose origin was previously turned on.
// Without this, "on" only ever lasted until the next navigation or reload.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const origin = originOf(tab.url);
  if (!origin) return;
  getEnabledOrigins().then((origins) => {
    if (origins.includes(origin)) startReadingInTab(tabId);
  });
});

let offscreenReadyPromise = null;
function ensureOffscreenDocument() {
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = (async () => {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS', 'AUDIO_PLAYBACK'],
        justification: 'Runs PaddleOCR (onnxruntime-web) on captured manga panel screenshots (needs a real page context — dynamic import(), which service workers cannot do) and, optionally, local Piper neural-TTS synthesis + audio playback.',
      });
    })();
  }
  return offscreenReadyPromise;
}

function captureVisibleTabDataUrl(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function runOcrInOffscreen(dataUrl) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'MVR_OCR_RUN', dataUrl }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp || resp.error) {
        reject(new Error((resp && resp.error) || 'OCR failed'));
        return;
      }
      resolve(resp);
    });
  });
}

// Manga image CDNs are commonly hotlink-protected behind bot-detecting WAFs
// (Cloudflare etc.) that key off signals like Sec-Fetch-Dest — headers a
// script can't set, since the browser controls them. A programmatic
// fetch()/XHR request (whether from a content script, bound by the page's
// CORS policy, or from this background worker, which bypasses CORS but
// still isn't a genuine <img> load) can get blocked outright regardless of
// which context sends it. Capturing the visible tab as a screenshot instead
// sidesteps all of that: it reads pixels already rendered by the browser,
// not bytes fetched over the network, so no CORS/WAF check applies at all.

// Kept around purely so it can be saved to a file on demand (see
// saveLastCapture below) — the *actual* screenshot the OCR pipeline just
// worked from, inspectable directly, instead of having to take on faith
// what's really being captured.
let lastCaptureDataUrl = null;

async function captureAndRecognize(windowId) {
  const dataUrl = await captureVisibleTabDataUrl(windowId);
  lastCaptureDataUrl = dataUrl;
  await ensureOffscreenDocument();
  return runOcrInOffscreen(dataUrl);
}

// TTS relay (Piper or Kokoro, picked per-call via `engine`): content.js has
// no path to the offscreen document's lifecycle (it doesn't know whether
// one exists yet), so it always goes through here first, same as the OCR
// capture flow above — ensureOffscreenDocument() is a no-op once one's
// already running.
function speakInOffscreen(text, voiceId, engine, volume) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'MVR_TTS_RUN', text, voiceId, engine, volume }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp || resp.ok === false) {
        reject(new Error((resp && resp.error) || 'TTS failed'));
        return;
      }
      resolve(resp);
    });
  });
}

async function speakWithTts(text, voiceId, engine, volume) {
  await ensureOffscreenDocument();
  return speakInOffscreen(text, voiceId, engine, volume);
}

// Best-effort: starts loading the TTS session (wasm init + first-use model
// download/decode) as soon as reading starts, rather than lazily on the
// first spoken line — shaves the one-time session cold-start off the very
// first bubble's latency. No return value worth waiting on; a real failure
// just surfaces normally on the first actual MVR_TTS_SPEAK instead.
async function warmTts(voiceId, engine) {
  await ensureOffscreenDocument();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'MVR_TTS_WARM_RUN', voiceId, engine }, () => resolve());
  });
}

// No return value worth waiting on — best-effort "make it so" (there may be
// no offscreen document yet at all, e.g. stopping before anything was ever
// read; that's fine).
function stopTtsPlayback() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'MVR_TTS_STOP_RUN' }, () => resolve());
  });
}

// Saves the last captured screenshot to a fixed filename in Downloads
// (overwriting each time) so it can be inspected directly as a file —
// e.g. read straight off disk — rather than only viewable inside the
// extension's own popup.
function saveLastCapture() {
  return new Promise((resolve, reject) => {
    if (!lastCaptureDataUrl) {
      reject(new Error('no capture yet'));
      return;
    }
    chrome.downloads.download(
      { url: lastCaptureDataUrl, filename: 'mvr-last-capture.png', conflictAction: 'overwrite', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed'));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'MVR_SAVE_LAST_CAPTURE') {
    saveLastCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'MVR_TTS_SPEAK') {
    speakWithTts(msg.text, msg.voiceId, msg.engine, msg.volume)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'MVR_TTS_STOP') {
    stopTtsPlayback().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'MVR_TTS_WARM') {
    warmTts(msg.voiceId, msg.engine).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'MVR_SET_SITE_ENABLED') {
    setOriginEnabled(msg.origin, msg.enabled).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type !== 'MVR_OCR_CAPTURE') return false;
  const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  captureAndRecognize(windowId)
    .then((data) => sendResponse(data))
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true; // keep the message channel open for the async sendResponse
});
