// Bundled into lib/kokoro-tts.bundle.mjs and imported by offscreen.js.
// `env` is re-exported directly from @huggingface/transformers (kokoro-js's
// own `env` re-export only exposes a `wasmPaths` setter, not the full object
// — see kokoro-js's dist/kokoro.js source) so numThreads can be tuned the
// same way it already is for onnxruntime-web/ppu-paddle-ocr in offscreen.js.
// Both packages resolve to the same hoisted top-level @huggingface/transformers
// install (confirmed via npm ls — no nested copy exists), so this is the
// exact same singleton `env` object kokoro-js itself reads from internally.
export { KokoroTTS } from 'kokoro-js';
export { env } from '@huggingface/transformers';
