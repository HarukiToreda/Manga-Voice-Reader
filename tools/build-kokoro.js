// Bundles kokoro-js (Kokoro-82M TTS via @huggingface/transformers/onnxruntime-web)
// into a single ESM file the offscreen document can import directly, and
// copies its onnxruntime-web wasm binary into lib/ so nothing is fetched
// from a remote CDN at runtime — same rationale as build-paddle.js/
// build-piper.js. @huggingface/transformers pins its own onnxruntime-web
// version (currently 1.22.0-dev...), separate from the 1.27.0 already used
// by PaddleOCR/comic-text-detector/Piper — npm doesn't dedupe these (a real,
// confirmed version mismatch, not a hypothetical one), so this needs its own
// lib/kokoro-ort/ directory rather than reusing lib/ort/.
// The actual Kokoro-82M model weights (~86MB at dtype "q8") and each
// selected voice's small style-vector .bin file are fetched from Hugging
// Face on first use and cached by the library itself via the Cache API —
// not bundled, not something this script touches.
// Run with: node build-kokoro.js

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const outfile = path.join(__dirname, '..', 'lib', 'kokoro-tts.bundle.mjs');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'build', 'kokoro-entry.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome110',
    outfile,
    // Steers @huggingface/transformers' internal onnxruntime-web import to
    // its smaller wasm-only build, same reasoning as build-paddle.js.
    alias: { 'onnxruntime-web': 'onnxruntime-web/wasm' },
    minify: true,
    logLevel: 'info',
  })
  .then(() => {
    const kokoroOrtDir = path.join(__dirname, '..', 'lib', 'kokoro-ort');
    fs.rmSync(kokoroOrtDir, { recursive: true, force: true });
    fs.mkdirSync(kokoroOrtDir, { recursive: true });
    const ortSrcDir = path.join(
      __dirname,
      'node_modules',
      '@huggingface',
      'transformers',
      'node_modules',
      'onnxruntime-web',
      'dist'
    );
    ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'].forEach((name) => {
      fs.copyFileSync(path.join(ortSrcDir, name), path.join(kokoroOrtDir, name));
      console.log('Copied', name, '->', kokoroOrtDir);
    });
    console.log('Bundle written to', outfile);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
