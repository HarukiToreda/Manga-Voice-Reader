// Bundles @mintplex-labs/piper-tts-web (local neural TTS, ONNX-based) into a
// single ESM file the offscreen document can import directly, and copies its
// two supporting binary assets (the ONNX Runtime wasm files — reused from
// build-paddle.js's own copy in lib/ort/ — plus piper_phonemize's own
// wasm+espeak-ng-data pair) into lib/ so nothing is fetched from a remote CDN
// at runtime. Voice model (.onnx) files are the one piece still fetched from
// Hugging Face on first use and cached in OPFS after that — see the "Known
// limitations" note in project memory; not worth mirroring locally until a
// specific voice is actually settled on.
// Run with: node build-piper.js

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const outfile = path.join(__dirname, '..', 'lib', 'piper-tts.bundle.mjs');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'build', 'piper-entry.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome110',
    outfile,
    // Unlike ppu-paddle-ocr/web (which imports plain 'onnxruntime-web' and
    // needs the alias to steer it to the smaller wasm-only build),
    // piper-tts-web's own dist already imports the "onnxruntime-web/wasm"
    // subpath directly — no alias needed, and aliasing it anyway causes
    // esbuild to double-append the subpath ("onnxruntime-web/wasm/wasm").
    // piper_phonemize's Emscripten-generated glue (piperWasm) carries
    // Node.js fallback code paths (require('fs')/require('path')) that are
    // dead in a real browser (guarded by an ENVIRONMENT_IS_NODE check that's
    // always false here) but which esbuild still tries to statically
    // resolve unless marked external.
    external: ['fs', 'path'],
    minify: true,
    logLevel: 'info',
  })
  .then(() => {
    const piperDir = path.join(__dirname, '..', 'lib', 'piper');
    fs.rmSync(piperDir, { recursive: true, force: true });
    fs.mkdirSync(piperDir, { recursive: true });
    ['piper_phonemize.wasm', 'piper_phonemize.data'].forEach((name) => {
      const src = path.join(__dirname, 'node_modules', '@diffusionstudio', 'piper-wasm', 'build', name);
      fs.copyFileSync(src, path.join(piperDir, name));
      console.log('Copied', name, '->', piperDir);
    });
    console.log('Bundle written to', outfile);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
