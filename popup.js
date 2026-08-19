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

const DEFAULT_SETTINGS = {
  piperVoiceId: PIPER_VOICES[0].id,
  direction: 'rtl',
  autoScrollSpeed: 140,
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

function populatePiperVoiceSelect() {
  const sel = el('piperVoiceSelect');
  sel.innerHTML = '';
  PIPER_VOICES.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    sel.appendChild(opt);
  });
  sel.value = settings.piperVoiceId;
}

function applySettingsToUI() {
  el('directionSelect').value = settings.direction;
  el('piperVoiceSelect').value = settings.piperVoiceId;
  el('autoScrollSpeedRange').value = settings.autoScrollSpeed;
  el('autoScrollSpeedValue').textContent = settings.autoScrollSpeed;
}

function saveSettings() {
  chrome.storage.sync.set({ mvrSettings: settings });
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
  el('processedCount').textContent = state.processedCount ?? 0;
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

  populatePiperVoiceSelect();
  applySettingsToUI();
  await refreshState();
  initPolling();

  el('startBtn').addEventListener('click', startReading);

  el('enableToggle').addEventListener('change', (e) => {
    sendToTab('MVR_SET_ENABLED', { enabled: e.target.checked });
    setSiteEnabled(e.target.checked);
  });

  el('piperVoiceSelect').addEventListener('change', (e) => {
    settings.piperVoiceId = e.target.value;
    pushSettings();
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

  el('replayLastBtn').addEventListener('click', () => sendToTab('MVR_REPLAY_LAST'));
  el('replayVisibleBtn').addEventListener('click', () => sendToTab('MVR_REPLAY_VISIBLE'));
  el('resetBtn').addEventListener('click', () => sendToTab('MVR_RESET_PROGRESS'));
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
