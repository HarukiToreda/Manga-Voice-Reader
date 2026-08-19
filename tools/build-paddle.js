// Bundles ppu-paddle-ocr/web + onnxruntime-web (wasm-only variant) into a
// single ESM file the offscreen document can import directly.
// Run with: node build-paddle.js
//
// A webgpu-capable build (the default, unaliased onnxruntime-web entry) was
// tried and reverted — live-tested slower than plain wasm for this
// workload's small, quick per-panel inferences, while also needing a ~2x
// larger bundled .wasm file (the "jsep" binary bundles both CPU wasm
// kernels and the JS-bridge code WebGPU needs). Back to the smaller,
// wasm-only "/wasm" subpath, which excludes that entirely.

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const outfile = path.join(__dirname, '..', 'lib', 'paddle-ocr.bundle.mjs');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'build', 'paddle-entry.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome110',
    outfile,
    alias: { 'onnxruntime-web': 'onnxruntime-web/wasm' },
    minify: true,
    logLevel: 'info',
  })
  .then(() => {
    // The wasm backend dynamically import()s the .mjs glue module from the
    // same directory as ort.env.wasm.wasmPaths (not just the .wasm binary)
    // to get the Emscripten module factory paired with this exact binary —
    // both files have to be copied, not just the .wasm one.
    const ortDir = path.join(__dirname, '..', 'lib', 'ort');
    fs.rmSync(ortDir, { recursive: true, force: true }); // drop any stale jsep files from a previous build
    fs.mkdirSync(ortDir, { recursive: true });
    ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'].forEach((name) => {
      const src = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist', name);
      fs.copyFileSync(src, path.join(ortDir, name));
      console.log('Copied', name, '->', ortDir);
    });
    console.log('Bundle written to', outfile);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
