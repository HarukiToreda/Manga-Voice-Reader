// Curated subset of Piper's much larger EN_US voice catalog (dozens of
// voices across many languages/accents — see @mintplex-labs/piper-tts-web's
// fixtures.ts PATH_MAP for the full list, already inspected directly this
// session) — a handful of well-regarded ones covering both genders, rather
// than dumping the entire catalog into one dropdown.
const PIPER_VOICES = [
  { id: 'en_US-hfc_female-medium', label: 'HFC Female (default)' },
  { id: 'en_US-amy-medium', label: 'Amy (female)' },
  { id: 'en_US-kathleen-low', label: 'Kathleen (female)' },
  { id: 'en_US-kristin-medium', label: 'Kristin (female)' },
  { id: 'en_US-ljspeech-high', label: 'LJSpeech (female, high quality — slower)' },
  { id: 'en_US-hfc_male-medium', label: 'HFC Male' },
  { id: 'en_US-ryan-medium', label: 'Ryan (male)' },
  { id: 'en_US-joe-medium', label: 'Joe (male)' },
  { id: 'en_US-danny-low', label: 'Danny (male)' },
  { id: 'en_US-bryce-medium', label: 'Bryce (male)' },
];

// Curated subset of Kokoro-82M's ~28 English voices (see the "Overall Grade"
// column in kokoro-js's own README — highest-graded voices, covering both
// genders and both US/UK accents, rather than dumping the whole catalog in).
const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart (US female, default)' },
  { id: 'af_bella', label: 'Bella (US female)' },
  { id: 'af_nicole', label: 'Nicole (US female)' },
  { id: 'af_sarah', label: 'Sarah (US female)' },
  { id: 'af_kore', label: 'Kore (US female)' },
  { id: 'am_fenrir', label: 'Fenrir (US male)' },
  { id: 'am_michael', label: 'Michael (US male)' },
  { id: 'am_puck', label: 'Puck (US male)' },
  { id: 'bf_emma', label: 'Emma (UK female)' },
  { id: 'bm_george', label: 'George (UK male)' },
];

const DEFAULT_SETTINGS = {
  ttsEngine: 'piper', // 'piper' or 'kokoro'
  piperVoiceId: PIPER_VOICES[0].id,
  kokoroVoiceId: KOKORO_VOICES[0].id,
  direction: 'rtl',
  autoScrollSpeed: 140,
  // 100 = unchanged from the loudness-normalized level offscreen.js already
  // synthesizes every line at (see normalizeWavLoudness) — this just scales
  // that at playback time via the <audio> element's native .volume.
  volume: 100,
};

let settings = { ...DEFAULT_SETTINGS };
let activeTabId = null;
let activeTabOrigin = null;
let pollHandle = null;

function setSiteEnabled(enabled) {
  if (!activeTabOrigin) return Promise.resolve(null);
  return sendToBackground('MVR_SET_SITE_ENABLED', { origin: activeTabOrigin, enabled });
}

const el = (id) => document.getElementById(id);

function sendToTab(type, extra) {
  if (!activeTabId) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(activeTabId, { type, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function sendToBackground(type, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function populateVoiceSelect(selectId, voices) {
  const sel = el(selectId);
  sel.innerHTML = '';
  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    sel.appendChild(opt);
  });
}

function applyEngineVisibility() {
  const isKokoro = settings.ttsEngine === 'kokoro';
  el('piperVoiceField').classList.toggle('hidden', isKokoro);
  el('piperHint').classList.toggle('hidden', isKokoro);
  el('kokoroVoiceField').classList.toggle('hidden', !isKokoro);
  el('kokoroHint').classList.toggle('hidden', !isKokoro);
}

function applySettingsToUI() {
  el('directionSelect').value = settings.direction;
  el('ttsEngineSelect').value = settings.ttsEngine;
  el('piperVoiceSelect').value = settings.piperVoiceId;
  el('kokoroVoiceSelect').value = settings.kokoroVoiceId;
  el('autoScrollSpeedRange').value = settings.autoScrollSpeed;
  el('autoScrollSpeedValue').textContent = settings.autoScrollSpeed;
  el('volumeRange').value = settings.volume;
  el('volumeValue').textContent = settings.volume;
  applyEngineVisibility();
}

function saveSettings() {
  chrome.storage.sync.set({ mvrSettings: settings });
}

const VOICE_PREVIEW_TEXT = 'Hello! This is what I sound like.';

// Goes straight to background.js's MVR_TTS_SPEAK relay (the same one
// content.js uses) rather than through sendToTab — synthesis/playback both
// happen in the offscreen document regardless of which tab is active, so no
// reading tab is needed just to preview a voice. Reads the select's current
// value directly rather than `settings.*Voice Id` — same value in practice
// (the change handlers below push immediately), but avoids depending on
// that ordering.
async function previewVoice(btn, engine, voiceId) {
  if (btn.disabled) return; // already playing a preview
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const resp = await sendToBackground('MVR_TTS_SPEAK', {
      text: VOICE_PREVIEW_TEXT,
      voiceId,
      engine,
      volume: Number(el('volumeRange').value),
    });
    if (!resp || resp.ok === false) throw new Error((resp && resp.error) || 'preview failed');
  } catch (e) {
    btn.textContent = '!';
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
    return;
  }
  btn.textContent = original;
  btn.disabled = false;
}

function pushSettings() {
  saveSettings();
  sendToTab('MVR_SET_SETTINGS', { settings });
}

function setStatusUI(state) {
  const dot = el('statusDot');
  const text = el('statusText');
  if (!state) {
    dot.className = '';
    text.textContent = 'Not active on this page';
    return;
  }
  dot.className = state.status || 'idle';
  const labels = {
    idle: 'Idle',
    scanning: 'Reading…',
    speaking: 'Speaking…',
    error: 'Had trouble reading a panel',
  };
  text.textContent = labels[state.status] || 'Active';
  el('enableToggle').checked = !!state.enabled;
}

async function refreshState() {
  const state = await sendToTab('MVR_GET_STATE');
  if (state) {
    el('controls').classList.remove('hidden');
    el('startBtn').classList.add('hidden');
    setStatusUI(state);
  } else {
    el('controls').classList.add('hidden');
    el('startBtn').classList.remove('hidden');
    setStatusUI(null);
  }
}

async function startReading() {
  if (!activeTabId) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: activeTabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['lib-shared/common-words.js', 'lib-shared/reading-order.js', 'content.js'],
    });
  } catch (e) {
    el('statusText').textContent = "Can't run on this page (browser/store page?)";
    return;
  }
  await sendToTab('MVR_INIT', { settings: { ...settings, enabled: true } });
  // Persists past this one tab/page load — background.js auto-resumes on
  // this origin's future page loads (reloads, next chapter, reopening the
  // tab later) without needing "Start reading" clicked again each time.
  await setSiteEnabled(true);
  await refreshState();
}

async function refreshLog() {
  const details = el('logDetails');
  const view = el('logView');
  if (!details || !view || !details.open) return; // only bother while the log is actually visible
  const resp = await sendToTab('MVR_GET_LOG');
  if (resp && resp.log && resp.log.length) {
    const nearBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 10;
    view.textContent = resp.log.join('\n');
    if (nearBottom) view.scrollTop = view.scrollHeight;
  } else {
    view.textContent = 'No log yet.';
  }
}

function initPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(async () => {
    const state = await sendToTab('MVR_GET_STATE');
    if (state) setStatusUI(state);
    refreshLog();
  }, 1000);
}

async function init() {
  const stored = await chrome.storage.sync.get('mvrSettings');
  if (stored.mvrSettings) settings = { ...DEFAULT_SETTINGS, ...stored.mvrSettings };

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0] && tabs[0].id;
  try {
    activeTabOrigin = tabs[0] && tabs[0].url ? new URL(tabs[0].url).origin : null;
  } catch (e) {
    activeTabOrigin = null;
  }

  populateVoiceSelect('piperVoiceSelect', PIPER_VOICES);
  populateVoiceSelect('kokoroVoiceSelect', KOKORO_VOICES);
  applySettingsToUI();
  await refreshState();
  initPolling();

  el('startBtn').addEventListener('click', startReading);

  el('enableToggle').addEventListener('change', (e) => {
    sendToTab('MVR_SET_ENABLED', { enabled: e.target.checked });
    setSiteEnabled(e.target.checked);
  });

  el('ttsEngineSelect').addEventListener('change', (e) => {
    settings.ttsEngine = e.target.value;
    applyEngineVisibility();
    pushSettings();
  });
  el('piperVoiceSelect').addEventListener('change', (e) => {
    settings.piperVoiceId = e.target.value;
    pushSettings();
  });
  el('kokoroVoiceSelect').addEventListener('change', (e) => {
    settings.kokoroVoiceId = e.target.value;
    pushSettings();
  });
  el('piperVoicePlayBtn').addEventListener('click', () => {
    previewVoice(el('piperVoicePlayBtn'), 'piper', el('piperVoiceSelect').value);
  });
  el('kokoroVoicePlayBtn').addEventListener('click', () => {
    previewVoice(el('kokoroVoicePlayBtn'), 'kokoro', el('kokoroVoiceSelect').value);
  });
  el('directionSelect').addEventListener('change', (e) => {
    settings.direction = e.target.value;
    pushSettings();
  });
  el('autoScrollSpeedRange').addEventListener('input', (e) => {
    // Live label update on every drag tick, but only persist/push on
    // 'change' below (once the user releases the slider) — avoids spamming
    // chrome.storage.sync.set on every intermediate value.
    el('autoScrollSpeedValue').textContent = e.target.value;
  });
  el('autoScrollSpeedRange').addEventListener('change', (e) => {
    settings.autoScrollSpeed = Number(e.target.value);
    pushSettings();
  });
  el('volumeRange').addEventListener('input', (e) => {
    el('volumeValue').textContent = e.target.value;
  });
  el('volumeRange').addEventListener('change', (e) => {
    settings.volume = Number(e.target.value);
    pushSettings();
  });

  el('readBtn').addEventListener('click', () => sendToTab('MVR_READ_NOW'));
  el('stopBtn').addEventListener('click', () => {
    sendToTab('MVR_STOP');
    setSiteEnabled(false);
  });
  el('logDetails').addEventListener('toggle', () => refreshLog());
  el('copyLogBtn').addEventListener('click', async () => {
    const btn = el('copyLogBtn');
    try {
      await navigator.clipboard.writeText(el('logView').textContent);
      btn.textContent = 'Copied!';
    } catch (e) {
      btn.textContent = "Couldn't copy";
    }
    setTimeout(() => {
      btn.textContent = 'Copy log';
    }, 1500);
  });
  el('saveCaptureBtn').addEventListener('click', async () => {
    const status = el('saveCaptureStatus');
    const resp = await sendToBackground('MVR_SAVE_LAST_CAPTURE');
    status.textContent = resp && resp.ok ? 'Saved to Downloads\\mvr-last-capture.png' : `Failed: ${(resp && resp.error) || 'no response'}`;
  });
}

init();
