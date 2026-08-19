// Runs the real-browser E2E test (see e2e-lib.js) across several real
// chapter pages in one session and aggregates the results — a single spot
// check isn't enough evidence of accuracy; this is the "run it more than
// once, on different real content" version. Each chapter is read start to
// finish (scrollThroughFullChapter in e2e-lib.js), not just a fixed-time
// sample of the first few panels.
//
// Usage: node e2e-suite.js [maxSecondsPerChapter] [chapterCount]
// Chapter URLs are discovered live from manganato.gg's homepage/listing
// (not hardcoded) so the suite doesn't silently go stale if links change —
// mangadot.net can't be used here, it blocks automated browsers via
// Cloudflare (see project memory); manganato.gg exercises the identical
// extension code path with no such block.

const path = require('path');
const { chromium } = require('playwright');
const { launchExtensionContext, runOneSession, summarizeLog } = require('./e2e-lib');

async function discoverChapterUrls(context, count) {
  const page = await context.newPage();
  await page.goto('https://www.manganato.gg/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const links = await page.$$eval('a', (as) =>
    as.map((a) => a.href).filter((h) => /\/manga\/[^/]+\/chapter-\d+$/i.test(h))
  );
  await page.close();
  // De-dupe while preserving order, then take the requested count.
  const seen = new Set();
  const unique = links.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  return unique.slice(0, count);
}

async function main() {
  const maxSeconds = Number(process.argv[2] || 180);
  const chapterCount = Number(process.argv[3] || 5);

  const userDataDir = path.join(__dirname, '.playwright-profile');
  const { context, background } = await launchExtensionContext(userDataDir);
  console.log('Extension loaded, service worker:', background.url());

  console.log(`Discovering ${chapterCount} real chapter URLs from manganato.gg...`);
  const urls = await discoverChapterUrls(context, chapterCount);
  if (!urls.length) {
    console.error('No chapter URLs discovered — site layout may have changed.');
    await context.close();
    process.exit(1);
  }
  urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  const results = [];
  for (const url of urls) {
    console.log(`\n--- Reading full chapter: ${url} (safety cap ${maxSeconds}s) ---`);
    const result = await runOneSession(context, background, url, maxSeconds);
    if (!result.ok) {
      console.log('  FAILED TO START:', result.error);
      results.push({ url, ok: false });
      continue;
    }
    const s = summarizeLog(result.log);
    console.log(
      `  captures=${s.captures} piperLines=${s.piperLines} systemFallback=${s.systemFallbackLines} ` +
        `droppedAsGarbage=${s.droppedGarbageCount} errors=${s.errorLines} pageErrors=${result.pageErrors.length}` +
        (result.hitSafetyCap ? ' [HIT SAFETY CAP — may not have reached the real end]' : '')
    );
    if (s.errors.length) s.errors.forEach((l) => console.log('    ERROR:', l));
    if (result.pageErrors.length) result.pageErrors.forEach((l) => console.log('    PAGE ERROR:', l));
    results.push({ url, ok: true, ...s, pageErrors: result.pageErrors.length, hitSafetyCap: result.hitSafetyCap });
  }

  await context.close();

  console.log('\n================ SUITE SUMMARY ================');
  const okResults = results.filter((r) => r.ok);
  const totals = okResults.reduce(
    (acc, r) => ({
      captures: acc.captures + r.captures,
      piperLines: acc.piperLines + r.piperLines,
      systemFallbackLines: acc.systemFallbackLines + r.systemFallbackLines,
      errorLines: acc.errorLines + r.errorLines,
      droppedGarbageCount: acc.droppedGarbageCount + r.droppedGarbageCount,
      pageErrors: acc.pageErrors + r.pageErrors,
    }),
    { captures: 0, piperLines: 0, systemFallbackLines: 0, errorLines: 0, droppedGarbageCount: 0, pageErrors: 0 }
  );
  console.log(`Chapters tested: ${results.length} (${okResults.length} started successfully)`);
  console.log(`Total captures across all chapters: ${totals.captures}`);
  console.log(`Total lines spoken via Piper: ${totals.piperLines}`);
  console.log(`Total lines that fell back to system voice: ${totals.systemFallbackLines}`);
  console.log(`Total bubbles dropped as garbage-shaped: ${totals.droppedGarbageCount}`);
  console.log(`Total error/fatal log lines: ${totals.errorLines}`);
  console.log(`Total uncaught page errors: ${totals.pageErrors}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`Chapters that failed to start: ${failed.map((r) => r.url).join(', ')}`);
  }
  const cappedChapters = okResults.filter((r) => r.hitSafetyCap);
  if (cappedChapters.length) {
    console.log(`Chapters that hit the safety cap (may not have reached the real end): ${cappedChapters.map((r) => r.url).join(', ')}`);
  }
  console.log('=================================================\n');

  const pass =
    okResults.length === results.length && totals.errorLines === 0 && totals.pageErrors === 0 && !cappedChapters.length;
  console.log(pass ? 'RESULT: PASS — no errors across the whole suite' : 'RESULT: ISSUES FOUND — see above');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
