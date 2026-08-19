// Bundled into lib/paddle-ocr.bundle.mjs and imported by background.js (a
// module-type MV3 service worker). Setting ort.env.wasm.wasmPaths here, at
// the top of this module's evaluation, runs before ppu-paddle-ocr/web's own
// platform.web.js sets its jsDelivr CDN default -- ESM evaluates imported
// modules (onnxruntime-web) before the importer's own body, so this
// assignment lands first and the library's `if (ort.env.wasm.wasmPaths) return`
// guard skips the CDN default. MV3 store policy forbids fetching executable
// WASM from a remote CDN, so the .wasm binary is bundled locally (lib/ort/)
// instead -- only the PP-OCR model weights (data, not code) are fetched from
// the network and cached.
import * as ort from 'onnxruntime-web';
ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');

export { PaddleOcrService, V6_TINY_MODEL, V6_SMALL_MODEL, V6_MEDIUM_MODEL } from 'ppu-paddle-ocr/web';
// Re-exported for comic-text-detector (lib-shared/comic-detector.js via
// offscreen.js) — a second, manga-trained ONNX model run through the same
// onnxruntime-web instance/wasm runtime already set up above, rather than
// bundling a whole separate copy of onnxruntime-web just for one more model.
export const InferenceSession = ort.InferenceSession;
export const Tensor = ort.Tensor;
export const ortEnv = ort.env;
