// Bundled into lib/piper-tts.bundle.mjs and imported by offscreen.js.
// piper-tts-web dynamically import()s its own copy of 'onnxruntime-web'
// internally (see TtsSession.init in the upstream source) — aliasing it to
// the wasm-only subpath here (see build-piper.js) keeps that consistent
// with the smaller, wasm-only bundle already used for PaddleOCR, instead of
// silently pulling in the ~2x larger webgpu-capable default build.
export { TtsSession, predict, voices, download, stored, remove, flush } from '@mintplex-labs/piper-tts-web';
