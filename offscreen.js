// Runs inside the extension's offscreen document (see background.js for why:
// onnxruntime-web's wasm backend uses a dynamic import() internally to load
// its glue module, which Chrome disallows inside a service worker even when
// it's module-type — https://github.com/w3c/ServiceWorker/issues/1356. An
// offscreen document is a real page context, so dynamic import() is fine
// here. The service worker still owns chrome.tabs.captureVisibleTab (an API
// offscreen documents don't have access to) and just relays the resulting
// screenshot here for OCR.

import { PaddleOcrService, InferenceSession, Tensor, ortEnv } from './lib/paddle-ocr.bundle.mjs';
import { TtsSession } from './lib/piper-tts.bundle.mjs';
import { KokoroTTS, env as kokoroEnv } from './lib/kokoro-tts.bundle.mjs';

// The bundled wasm binary is the "simd-threaded" variant (capable of
// splitting a single inference's compute across worker threads), but
// onnxruntime-web still defaulted numThreads to 1 here — confirmed live via
// a debug query (offscreen document: hardwareConcurrency 16, SharedArrayBuffer
// available, wasmNumThreads 1). Actually using the machine's other cores cut
// comic-text-detector's measured ~8s single-threaded inference time down to
// ~1-2s (validated live, 2026-08-19). Must be set before any session is
// created (getPaddleService/getComicDetectorSession are both lazy, so this
// assignment always runs first).
ortEnv.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);

// Tried WebGPU here (auto-detected via getDefaultWebExecutionProviders,
// falling back to wasm) hoping for the library's documented 2-5x speedup.
// Live-tested: made captures noticeably slower, not faster, for this
// workload — small, quick per-panel inferences where WebGPU's own context/
// buffer-transfer overhead apparently outweighs any compute win. Reverted
// to wasm-only, which was already fast (~200-400ms/capture) and doesn't
// carry the ~2x larger bundled .wasm the webgpu-capable build needs.
//
// Also tried suppressing digit/CJK recognition classes at the CTC-decode
// level (blanking their entries in the recognition dictionary, so those
// classes could never be emitted as characters) — reverted. Validated
// cleanly against a saved capture and the 5-page regression benchmark via
// the Node-testable package variant, but that variant's dictionary-override
// mechanism turned out to differ from the browser (`ppu-paddle-ocr/web`)
// variant actually shipped here in a way that couldn't be fully exercised in
// Node (`createImageBitmap` isn't available outside a real browser).
// Live-tested by the user as worse: blanking a digit mid-token ("Ch.9.0")
// produced an unwanted inserted space ("Ch. .") that the Node-tested path
// didn't show, which then tripped the bad-draw retry on every single
// capture (the watermark text appears on every page) — a real, reproducible
// latency regression, not a fluke. Reverted rather than iterating further
// blind; the underlying problem (digit/CJK misreads) is real and worth
// revisiting, but needs a way to validate the exact browser code path
// before trying again, not another guess.
let paddleServicePromise = null;
function getPaddleService() {
  if (!paddleServicePromise) {
    const service = new PaddleOcrService({
      session: { executionProviders: ['wasm'] },
      debugging: { debug: false, verbose: false },
      // Default detection.maxSideLength is "auto" — clamp(0.75 * longestSide,
      // 960, 1920) — which downscales a typical ~1280px-wide capture to
      // 960px *before the detector even runs*. Pinning it to full native
      // resolution recovered text that was being silently missed entirely
      // (validated live, 2026-08-18: a 4-line speech bubble where only one
      // fragment was ever detected now reads in full). Distinct from the
      // already-tried-and-rejected "detection resolution up to 3000px"
      // experiment documented in project memory — that was for a
      // *line-merging* symptom, not text never being detected at all.
      detection: { maxSideLength: 1920 },
    });
    paddleServicePromise = service.initialize().then(() => service);
  }
  return paddleServicePromise;
}

// comic-text-detector (lib-shared/comic-detector.js): a second, manga-
// trained detector run *before* PaddleOCR on each full capture, to find
// text-block regions PaddleOCR's own general-document-trained detector
// misses outright — confirmed via a full manual chapter audit that it finds
// real dialogue (both in dense speed-line action art and, less expectedly,
// some plain panels) PaddleOCR's detector never once detected. Detection-
// only: PaddleOCR still does the actual word-level recognition, just on a
// small crop of each block instead of the whole noisy page (see
// recognizeDataUrl below for why that crop-then-recognize shape was chosen
// over trying to feed this model's boxes directly into PaddleOCR's
// recognizer). Session reused across the whole offscreen-document lifetime,
// same pattern as getPaddleService.
// The model itself (94.7MB) isn't bundled into the extension package —
// mirrors Piper's voice models below exactly: MV3 store policy forbids
// fetching executable *code* remotely, but this is model *weights*, pure
// data fed into the already-locally-bundled onnxruntime-web wasm engine,
// the same distinction that already justifies Piper's remote fetch.
// Fetched once per browser profile and cached in OPFS; every capture after
// the first genuine use of this rescue pass reads the cached copy instead
// of re-downloading.
const COMIC_DETECTOR_MODEL_URL =
  'https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/main/comic-text-detector.onnx';
const COMIC_DETECTOR_OPFS_NAME = 'comic-text-detector.onnx';

async function fetchModelWithOpfsCache(url, opfsName) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsName).catch(() => null);
    if (handle) {
      const file = await handle.getFile();
      if (file.size > 0) return await file.arrayBuffer();
    }
  } catch (e) {
    // OPFS unavailable/unreadable — fall through to a plain fetch below.
  }
  const buf = await (await fetch(url)).arrayBuffer();
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(buf);
    await writable.close();
  } catch (e) {
    // Caching failed (quota, unsupported) — still usable this once, just
    // re-downloads next time instead of erroring out now.
  }
  return buf;
}

let comicDetectorSessionPromise = null;
function getComicDetectorSession() {
  if (!comicDetectorSessionPromise) {
    comicDetectorSessionPromise = fetchModelWithOpfsCache(COMIC_DETECTOR_MODEL_URL, COMIC_DETECTOR_OPFS_NAME).then(
      (buf) => InferenceSession.create(buf, { executionProviders: ['wasm'] })
    );
  }
  return comicDetectorSessionPromise;
}

// Standard luma weighting, converting the captured RGBA pixels to the
// grayscale buffer findBorderBands expects — matches the grayscale
// conversion used while developing/validating the detection thresholds
// (sharp's default grayscale, tested against real pages) closely enough
// that the same threshold values apply here too.
function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return gray;
}

async function recognizeDataUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Detected once per capture, alongside OCR — see lib-shared/panel-detect.js
  // for why (bubble reading order had no concept of "panel" at all, purely
  // text-box geometry, which caused bubbles from different side-by-side
  // panels to get interleaved when their text boxes happened to vertically
  // overlap). Strictly additive: an empty/no-op result here just means
  // MVR_LOGIC.orderBubbles falls back to its original panel-unaware
  // behavior, unchanged.
  const panelBorders = MVR_PANELS.findBorderBands(
    toGrayscale(ctx.getImageData(0, 0, canvas.width, canvas.height)),
    canvas.width,
    canvas.height
  );

  const service = await getPaddleService();
  // Fast path first, unchanged from before comic-text-detector existed:
  // PaddleOCR's own whole-canvas detect+recognize handles the large
  // majority of captures fine on its own. Only escalate to the
  // comic-text-detector rescue pass (see recognizeViaBlocks) when this
  // comes back suspiciously thin — measured live at ~8s for the detector's
  // own forward pass alone (onnxruntime-web's wasm backend is far slower
  // than native here, unlike PaddleOCR's own much lighter detector), so
  // running it on every single capture would roughly triple typical
  // latency for no benefit on the captures that already work fine.
  // Threshold of <=1 kept word: every confirmed real miss this session
  // (full manual chapter audit) had either zero or exactly one word survive
  // PaddleOCR's own detection+filtering in an otherwise real, content-
  // bearing panel — genuinely near-silent panels exist too (a single
  // shouted "HORSE!"), so this will sometimes pay the rescue cost for
  // nothing, but never on the panels that already have plenty of text.
  const primary = await service.recognize(canvas, RECOGNIZE_OPTS);
  const primaryWords = toWords(primary.results);
  // The chapter-number watermark ("Ch.68.2") and site UI chrome text (e.g.
  // "Shortcuts are now rebindable...") are near-constant across almost
  // every capture and would otherwise mask a genuinely sparse/failed
  // detection from this count — confirmed live: a capture with real content
  // reduced to just "HORSE!" still passed a naive >1-word check because the
  // watermark and a UI toast counted as two more "words." Reader-chrome
  // filtering normally happens downstream in content.js/reading-order.js on
  // the *merged* text; this is a narrower, word-level approximation of the
  // same idea, good enough for "does this look worth a rescue pass."
  const REAL_CONTENT_WORD_COUNT = primaryWords.filter(
    (w) => !/^Ch\.?\s*\d/i.test(w.text) && !MVR_LOGIC.isReaderChrome(w.text)
  ).length;
  if (REAL_CONTENT_WORD_COUNT > 1) {
    return { words: primaryWords, width: canvas.width, height: canvas.height, panelBorders };
  }
  const rescueWords = await recognizeViaBlocks(service, canvas, primaryWords);
  return { words: rescueWords, width: canvas.width, height: canvas.height, panelBorders };
}

// flatten + per-box: a flat list of individually-detected/recognized text
// regions, not grouped into Paddle's own line/paragraph structure — the
// content script rebuilds lines and speech bubbles itself from these boxes
// (lib-shared/reading-order.js), the same way it did with Tesseract's word
// boxes, so that logic doesn't need to change.
const RECOGNIZE_OPTS = { flatten: true, strategy: 'per-box', noCache: true };
// This project only handles English-language scanlations, so a real word
// always has at least one Latin letter in it. PaddleOCR occasionally
// hallucinates a stray CJK glyph or symbol out of background art/screentone
// texture (confirmed live: "曰" appearing mid-bubble in "KOU-TAROU? THE
// BATHROOM."). Left in, a single non-Latin word like that rides along
// inside an otherwise-real bubble's text (the bubble as a whole is still
// mostly Latin letters, so isLikelyGarbage's ratio check never sees it) and
// gets handed to the speech engine, which either mispronounces it or fails
// outright on it. Filtering at the raw-word stage, before words are ever
// merged into lines/bubbles, means the contamination can't happen at all.
function toWords(results) {
  return results
    .filter((r) => r.text && r.text.trim().length >= 1 && /[A-Za-z]/.test(r.text))
    .map((r) => ({
      text: r.text.trim(),
      bbox: { x0: r.box.x, y0: r.box.y, x1: r.box.x + r.box.width, y1: r.box.y + r.box.height },
      confidence: r.confidence * 100, // Paddle is 0-1; the rest of the pipeline expects 0-100 (Tesseract's scale)
    }));
}

// Padding added around each comic-text-detector block before cropping —
// its boxes are fit fairly tight to visible ink, and PaddleOCR's own
// recognizer (still doing the real word-level work here, just on a small
// crop) needs a little breathing room around the text the same way its own
// detection.paddingVertical/Horizontal already do for its own boxes.
const BLOCK_CROP_PADDING_PX = 12;
// Two padded crops from adjacent blocks can overlap a little; a word found
// in both would otherwise get queued and spoken twice. Kept deliberately
// high (only merges near-exact duplicates) — this is a safety net for
// crop-boundary overlap, not a general dedup pass.
const DUPLICATE_IOU_THRESHOLD = 0.6;

function bboxArea(b) {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}
function bboxIou(a, b) {
  const x1 = Math.max(a.x0, b.x0);
  const y1 = Math.max(a.y0, b.y0);
  const x2 = Math.min(a.x1, b.x1);
  const y2 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (bboxArea(a) + bboxArea(b) - inter + 1e-9);
}

// comic-text-detector finds *where* the text blocks are (whole-bubble
// boxes; see lib-shared/comic-detector.js for why it's needed at all).
// PaddleOCR then runs its own normal detect+recognize on each cropped
// block instead of the full page — deliberately not trying to feed this
// model's block boxes directly into PaddleOCR's recognizer, since that
// would need reverse-engineering an unsupported internal entry point;
// running the existing, already-working recognize() call on a small,
// isolated crop gets the same benefit (no competing surrounding art/motion
// lines fighting for the detector's attention) through the public API this
// project already depends on. If comic-text-detector finds nothing at all
// (blank/near-blank capture), falls back to a single whole-canvas
// recognize() so a genuinely empty capture still resolves the same way it
// always did rather than returning nothing.
// Measured live: the detector's own forward pass is ~7.5-8s in
// onnxruntime-web's wasm backend (its 1024x1024 fixed input shape can't be
// reduced without re-exporting the model — tried, the ONNX graph rejects
// any other size), regardless of the source capture's own dimensions. This
// is the real cost of this rescue pass; it's why recognizeDataUrl only
// calls this on captures the fast primary pass came back suspiciously thin
// on, never on every capture.
async function recognizeViaBlocks(service, canvas, primaryWords) {
  const detectorSession = await getComicDetectorSession();
  const blocks = await MVR_COMIC_DETECTOR.detectBlocks(detectorSession, Tensor, canvas);
  if (!blocks.length) return primaryWords;

  // Starts from the primary pass's own words (usually just the "Ch.68.2"-
  // style watermark, since this only runs when that pass found <=1 word) —
  // the dedup pass below then drops any block-crop word that re-finds the
  // same thing, and keeps anything genuinely new.
  const allWords = primaryWords.slice();
  for (const block of blocks) {
    const x0 = Math.max(0, Math.floor(block.xyxy[0] - BLOCK_CROP_PADDING_PX));
    const y0 = Math.max(0, Math.floor(block.xyxy[1] - BLOCK_CROP_PADDING_PX));
    const x1 = Math.min(canvas.width, Math.ceil(block.xyxy[2] + BLOCK_CROP_PADDING_PX));
    const y1 = Math.min(canvas.height, Math.ceil(block.xyxy[3] + BLOCK_CROP_PADDING_PX));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 4 || h < 4) continue;
    const cropCanvas = new OffscreenCanvas(w, h);
    cropCanvas.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    // noCache: true is required, not optional — ppu-paddle-ocr's recognize()
    // caches results by default, keyed on a hash of only the first 1024
    // bytes of the raw pixel buffer plus the total buffer length (see
    // core/image-cache.js). Different crops can easily collide on that key
    // (same size, visually similar top-left corner), which would silently
    // return a stale, unrelated crop's result — confirmed as the root cause
    // of an earlier "only ever reads the first thing it saw" bug on the
    // original whole-canvas call; the same risk applies here, if anything
    // more so with many same-shaped small crops per capture.
    const cropResult = await service.recognize(cropCanvas, RECOGNIZE_OPTS);
    for (const w of toWords(cropResult.results)) {
      w.bbox = { x0: w.bbox.x0 + x0, y0: w.bbox.y0 + y0, x1: w.bbox.x1 + x0, y1: w.bbox.y1 + y0 };
      allWords.push(w);
    }
  }

  // Drop near-duplicate words from overlapping crop padding, keeping
  // whichever copy has higher confidence.
  allWords.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const word of allWords) {
    const isDup = kept.some(
      (k) => k.text === word.text && bboxIou(k.bbox, word.bbox) >= DUPLICATE_IOU_THRESHOLD
    );
    if (!isDup) kept.push(word);
  }
  return kept;
}

// ---------------- Piper TTS (local neural voice, experimental) ----------------
//
// Why here and not directly in the content script: piper-tts-web dynamically
// import()s onnxruntime-web the same way ppu-paddle-ocr/web does (see the
// file header above) — same dynamic-import-inside-service-worker restriction
// applies, so this needs the same offscreen-document workaround.
//
// TtsSession is a module-level singleton *inside the bundled library
// itself*: the first voiceId it's ever created with is the only one that
// gets its model downloaded and an ONNX session built — calling create()
// again with a different voiceId only relabels `.voiceId` on the existing
// instance without reloading anything (confirmed by reading the library's
// own source). But `TtsSession._instance` is a plain public static class
// field, not `#`-private — also confirmed directly from source, not
// assumed — so it can be reset from outside the class to force a genuinely
// fresh session on the next create() call, without needing to tear down and
// recreate the whole offscreen document. getPiperSession(voiceId) does
// exactly that whenever the requested voice differs from whichever one the
// current session was built for.
const DEFAULT_PIPER_VOICE_ID = 'en_US-hfc_female-medium';

// ---------------- Kokoro TTS (local neural voice, alternative engine) ----------------
//
// Unlike Piper (a separate ~60MB model download per voice), Kokoro-82M is
// one shared model — each voice is just a small style-vector .bin file
// applied at generation time — so there's only ever one session to load
// regardless of which voice is selected, no per-voice session-swapping
// logic needed the way getPiperSession has.
// wasmPaths points at lib/kokoro-ort/ (a separate copy from lib/ort/ — see
// build-kokoro.js for why: @huggingface/transformers pins its own
// onnxruntime-web version, not the 1.27.0 already used elsewhere in this
// file). Model weights (~86MB at dtype "q8") and each voice's style-vector
// file are fetched from Hugging Face on first use and cached by the
// library itself via the Cache API — same remote-data-not-remote-code
// distinction as the comic-text-detector model and Piper's voice models.
kokoroEnv.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/kokoro-ort/');
kokoroEnv.backends.onnx.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);

const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_KOKORO_VOICE_ID = 'af_heart';

// dtype "q4" was benchmarked live against "q8" (same warm-session
// methodology as the Piper-vs-Kokoro comparison above) and came back
// *slower* on average (~6.57s/line vs q8's ~5.77s/line, 2026-08-19) on top
// of lower audio quality — this wasm CPU backend has no real int4
// acceleration, so dequantizing on the fly outweighs any bandwidth
// savings. q8 wins on both axes; not worth making this configurable.
let kokoroSessionPromise = null;
function getKokoroSession() {
  if (!kokoroSessionPromise) {
    kokoroSessionPromise = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
    });
  }
  return kokoroSessionPromise;
}

let piperSessionPromise = null;
let piperSessionVoiceId = null;
function getPiperSession(voiceId) {
  const targetVoiceId = voiceId || DEFAULT_PIPER_VOICE_ID;
  if (piperSessionPromise && piperSessionVoiceId === targetVoiceId) {
    return piperSessionPromise;
  }
  TtsSession._instance = null;
  piperSessionVoiceId = targetVoiceId;
  piperSessionPromise = TtsSession.create({
    voiceId: targetVoiceId,
    // Mirrors build-paddle.js's local-bundling approach: the model itself
    // (data, not code) still comes from Hugging Face on first use and is
    // cached in OPFS after that (see TtsSession.init's getBlob calls,
    // upstream — not something the wasmPaths option covers), but the wasm
    // *code* these two loaders need is local, not fetched from a CDN. A
    // voice switch means a genuinely new ~60MB download the first time that
    // specific voice is used; already-used voices stay cached in OPFS.
    wasmPaths: {
      onnxWasm: chrome.runtime.getURL('lib/ort/'),
      piperWasm: chrome.runtime.getURL('lib/piper/piper_phonemize.wasm'),
      piperData: chrome.runtime.getURL('lib/piper/piper_phonemize.data'),
    },
  });
  return piperSessionPromise;
}

// Only one utterance plays at a time — tracked (audio element + the promise
// resolver awaiting it) so a STOP request can actually interrupt what's
// currently sounding, not just leave it playing under a discarded reference.
// Interrupting via .pause() alone would leave synthesizeAndPlay's promise
// hanging forever — .pause() fires a 'pause' event, not 'ended' — which
// would freeze content.js's whole reading loop (it awaits each line in
// sequence). Holding the resolver directly lets a stop unblock it explicitly.
let currentPlayback = null; // { audio, resolve }

// ---------------- loudness normalization ----------------
//
// Piper and Kokoro (and different voices within each) come out at
// noticeably different volumes — each TTS model's own training data sets
// its own output level, nothing to do with anything on our end. Rather
// than hand-tuning a fixed per-voice gain table (which would need
// re-tuning any time a voice is swapped and can't really be validated
// without a human actually listening), this measures each generated
// clip's own RMS level and applies a single per-clip gain to bring it to
// a common target — the same idea as ReplayGain/podcast loudness
// normalization, just simple linear RMS instead of full LUFS. A peak
// safety clamp keeps that gain from ever pushing samples into clipping.
const TARGET_RMS = 0.1; // ~-20dBFS, a common speech loudness target
const MAX_NORMALIZE_GAIN = 4; // caps amplification of near-silent clips
const PEAK_CEILING = 0.98;

let sharedAudioCtx = null;
function getAudioContext() {
  if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
  return sharedAudioCtx;
}

function encodeWavFromAudioBuffer(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const blockAlign = numChannels * 2; // 16-bit PCM
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

function measureRms(audioBuffer) {
  let sumSquares = 0;
  let sampleCount = 0;
  let peak = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      sumSquares += s * s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    sampleCount += data.length;
  }
  return { rms: Math.sqrt(sumSquares / Math.max(1, sampleCount)), peak };
}

// Returns { blob, rmsBefore, rmsAfter } — the before/after RMS is threaded
// into the response timing object purely as debug telemetry (surfaces in
// the popup's debug log), so a volume-level regression would actually be
// visible instead of only found by ear.
async function normalizeWavLoudness(wavBlob) {
  const audioCtx = getAudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(await wavBlob.arrayBuffer());
  const { rms, peak } = measureRms(audioBuffer);
  if (rms < 1e-6 || peak < 1e-6) return { blob: wavBlob, rmsBefore: rms, rmsAfter: rms }; // near-silence
  let gain = Math.min(TARGET_RMS / rms, MAX_NORMALIZE_GAIN);
  if (peak * gain > PEAK_CEILING) gain = PEAK_CEILING / peak; // never clip
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  const blob = new Blob([encodeWavFromAudioBuffer(audioBuffer)], { type: 'audio/wav' });
  return { blob, rmsBefore: rms, rmsAfter: rms * gain };
}

// Loads whichever engine's session/model is needed and returns a playable,
// loudness-normalized WAV Blob — the one piece that differs between
// engines is upstream of normalizeWavLoudness; everything after that
// (playback, interruption, timing) is shared.
async function synthesizeWav(text, voiceId, engine) {
  let wavBlob;
  if (engine === 'kokoro') {
    const tts = await getKokoroSession();
    const audio = await tts.generate(text, { voice: voiceId || DEFAULT_KOKORO_VOICE_ID });
    wavBlob = audio.toBlob();
  } else {
    const session = await getPiperSession(voiceId);
    wavBlob = await session.predict(text);
  }
  return normalizeWavLoudness(wavBlob);
}

async function synthesizeAndPlay(text, voiceId, engine) {
  const t0 = performance.now();
  const { blob: wavBlob, rmsBefore, rmsAfter } = await synthesizeWav(text, voiceId, engine);
  const t1 = performance.now();
  interruptCurrentPlayback();
  const url = URL.createObjectURL(wavBlob);
  const audio = new Audio(url);
  // sessionMs/synthMs used to be split (session load vs. actual synth) —
  // collapsed into one combined figure since Kokoro's from_pretrained()
  // and generate() are both awaited inside the shared synthesizeWav()
  // helper now, with no seam between them visible from out here.
  const timing = {
    sessionMs: 0,
    synthMs: Math.round(t1 - t0),
    playStartMs: 0,
    rmsBefore: Math.round(rmsBefore * 1000) / 1000,
    rmsAfter: Math.round(rmsAfter * 1000) / 1000,
  };
  try {
    await new Promise((resolve, reject) => {
      currentPlayback = { audio, resolve };
      audio.onended = resolve;
      audio.onerror = () => reject(new Error('TTS audio playback failed'));
      audio.play().then(() => {
        // Timing only — doesn't affect the awaited onended above.
        timing.playStartMs = Math.round(performance.now() - t1);
      }).catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
    if (currentPlayback && currentPlayback.audio === audio) currentPlayback = null;
  }
  return timing;
}

function interruptCurrentPlayback() {
  if (currentPlayback) {
    currentPlayback.audio.pause();
    URL.revokeObjectURL(currentPlayback.audio.src);
    currentPlayback.resolve();
    currentPlayback = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'MVR_OCR_RUN') {
    recognizeDataUrl(msg.dataUrl)
      .then((data) => sendResponse(data))
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'MVR_TTS_RUN') {
    synthesizeAndPlay(msg.text, msg.voiceId, msg.engine)
      .then((timing) => sendResponse({ ok: true, ...timing }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'MVR_TTS_STOP_RUN') {
    interruptCurrentPlayback();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'MVR_TTS_WARM_RUN') {
    // Fire-and-forget: kicks off session creation (wasm init + first-use
    // model download/decode) right when reading starts, instead of paying
    // that cost as part of the very first line's latency. Errors are
    // swallowed here — the real attempt (and its real error handling) still
    // happens on the first genuine MVR_TTS_RUN.
    (msg.engine === 'kokoro' ? getKokoroSession() : getPiperSession(msg.voiceId)).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
