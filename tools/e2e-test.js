// Single-URL, verbose version — loads the actual unpacked extension into a
// real Chromium instance via Playwright and scrolls it through an entire
// real chapter, start to finish (see e2e-lib.js's scrollThroughFullChapter —
// stops when it genuinely reaches the bottom, not after a fixed time). For
// validating across several chapters at once, use e2e-suite.js instead.
//
// Usage: node e2e-test.js <url> [maxSeconds]

const path = require('path');
const { launchExtensionContext, runOneSession, summarizeLog } = require('./e2e-lib');

async function main() {
  const url = process.argv[2];
  const maxSeconds = Number(process.argv[3] || 180);
  if (!url) {
    console.error('Usage: node e2e-test.js <url> [maxSeconds]');
    process.exit(1);
  }

  const userDataDir = path.join(__dirname, '.playwright-profile');
  const { context, background } = await launchExtensionContext(userDataDir);
  console.log('Extension loaded, service worker:', background.url());

  console.log('Reading the full chapter (safety cap', maxSeconds, 's) at', url);
  const result = await runOneSession(context, background, url, maxSeconds);

  console.log('\n================ MVR DEBUG LOG ================');
  console.log(result.log.join('\n'));
  console.log('================ END LOG ================\n');

  if (result.pageErrors.length) {
    console.log('Page errors:', result.pageErrors);
  }

  const s = summarizeLog(result.log);
  console.log('================ VERIFICATION SUMMARY ================');
  console.log('Reading-order captures:', s.captures);
  console.log('Lines spoken via Piper:', s.piperLines);
  console.log(
    'Lines that fell back to system voice:',
    s.systemFallbackLines,
    s.systemFallbackLines ? '(check why — Piper should be handling these)' : ''
  );
  console.log('Bubbles dropped as garbage-shaped (possible misreads):', s.droppedGarbageCount);
  console.log('Error/fatal lines:', s.errorLines);
  if (s.errors.length) s.errors.forEach((l) => console.log('  ', l));
  if (result.hitSafetyCap) {
    console.log('WARNING: hit the maxSeconds safety cap before confirming the real chapter bottom — increase it if this chapter is unusually long.');
  }
  console.log('========================================================\n');

  await context.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
