// Shared logic for driving the real extension in a real Chromium instance —
// used by both e2e-test.js (single-URL, verbose) and e2e-suite.js (multiple
// URLs, aggregated). See e2e-test.js's header comment for why this exists
// (plain Node can't exercise ppu-paddle-ocr/web's real createImageBitmap/
// OffscreenCanvas code path — this launches a real browser instead).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const EXTENSION_PATH = path.join(__dirname, '..');
const DEFAULT_SETTINGS = {
  enabled: true,
  piperVoiceId: 'en_US-hfc_female-medium',
  direction: 'rtl',
  autoScrollSpeed: 140,
};

// Always launches from a genuinely fresh profile — deletes any existing
// userDataDir first. Two other approaches were tried and both failed for
// real, confirmed reasons, not just theoretical ones: reusing a profile
// across runs let Chrome's MV3 service worker registration silently outlive
// the on-disk background.js it started from (editing background.js and
// relaunching against the *same* profile kept running the *previous*
// version with zero error — confirmed directly: a newly-added listener
// produced zero console output across several reused-profile runs, then
// worked immediately on a fresh one). Trying to force a fresh registration
// via chrome.runtime.reload() on a reused profile was worse: it either hung
// waiting for a 'serviceworker' event Playwright never re-fired, or in one
// run tore down the whole browser context outright ("Target page, context
// or browser has been closed"). A fresh profile side-steps the entire
// problem at the cost of re-downloading Piper's ~60MB voice model every
// run — worth it for a testing tool, where "did this actually test the
// current code" matters more than shaving off that download.
async function launchExtensionContext(userDataDir, contextOptions) {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--mute-audio'],
    // Optional Playwright context overrides (e.g. { deviceScaleFactor: 2 })
    // — needed to reproduce/validate DPI-scaling-specific bugs, since this
    // harness's default profile always runs at devicePixelRatio 1 and can't
    // otherwise catch that whole class of issue (see the deviceYToCssY fix
    // in content.js for a real bug that was invisible under default testing
    // for exactly this reason).
    ...(contextOptions || {}),
  });
  let background = context.serviceWorkers()[0];
  if (!background) background = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, background };
}

// Scrolls to the genuine bottom of *this* chapter, not just for a fixed
// duration and not by watching overall page height. A manga chapter can be
// very short (a few panels) or very long (60+ stacked pages — confirmed
// live: one real chapter had 54 sequential panel images, 65698px of scroll
// distance), so a fixed-time scroll either cuts a long chapter off partway
// through or wastes time over-scrolling a short one. Two things had to be
// fixed to get this right, both confirmed against real pages, not guessed:
// 1. Watching document.body.scrollHeight for "reached bottom" doesn't work
//    — these readers auto-load the *next* chapter's images once you scroll
//    near the end (continuous-reading UX), which keeps growing scrollHeight
//    indefinitely. Fixed by snapshotting this chapter's own known image list
//    at load time (before scrolling can trigger a next-chapter preload) and
//    targeting the *last one of those specific images* instead — a fixed
//    target that can't move once captured, unlike overall page height.
// 2. Even with the right target, a fixed tick budget derived from a
//    guessed wall-clock duration doesn't scale — a 54-image chapter simply
//    needs more ticks than a 14-image one to physically cover the distance.
//    Fixed by measuring the target's actual initial position and computing
//    how many scroll steps are really needed to reach it, instead of
//    guessing a duration and hoping it's enough.
async function scrollThroughFullChapter(page, tickMs, minTicks) {
  // Group by directory and take the largest group's last image, rather than
  // just "the last <img> on the page at load" — some readers place "next
  // chapter" / "you may also like" recommendation thumbnails below the
  // actual story content, which can outrank or trail the real last panel and
  // send the scroll target chasing something that isn't this chapter at all
  // (confirmed live: capture counts didn't converge until this was fixed).
  // A chapter's own sequential panel images (0.webp, 1.webp, 2.webp, ...)
  // all share one directory and are, by a wide margin, the largest same-
  // directory group on the page — unrelated thumbnails are one-offs from
  // other directories.
  const lastKnownImageSrc = await page.evaluate(() => {
    const urls = Array.from(document.images)
      .map((img) => img.src)
      .filter((src) => /\.(webp|jpe?g|png)(\?|$)/i.test(src) && !/logo|icon|avatar|banner/i.test(src));
    const byDir = new Map();
    for (const u of urls) {
      const dir = u.slice(0, u.lastIndexOf('/'));
      (byDir.get(dir) || byDir.set(dir, []).get(dir)).push(u);
    }
    let bestDir = null;
    let bestCount = 0;
    for (const [dir, list] of byDir) {
      if (list.length > bestCount) {
        bestCount = list.length;
        bestDir = dir;
      }
    }
    if (!bestDir || bestCount < 2) return null;
    const group = byDir.get(bestDir);
    return group[group.length - 1];
  });

  const scrollStep = 650;
  // Compute how many ticks this specific chapter actually needs to reach its
  // own last panel, rather than trusting an externally-guessed tick budget —
  // that's what let a 54-image chapter silently time out while a 14-image
  // one finished with ticks to spare. minTicks still acts as a floor (and,
  // via the 400 ceiling, an upper safety net if detection ever fails).
  let maxTicks = minTicks;
  if (lastKnownImageSrc) {
    const initialTop = await page.evaluate((src) => {
      const img = Array.from(document.images).find((el) => el.src === src);
      return img ? img.getBoundingClientRect().top : null;
    }, lastKnownImageSrc);
    if (initialTop !== null) {
      const neededTicks = Math.ceil(Math.max(0, initialTop) / scrollStep) + 2;
      maxTicks = Math.min(Math.max(minTicks, neededTicks), 400);
    }
  }

  let ticksUsed = 0;
  for (let i = 0; i < maxTicks; i++) {
    ticksUsed++;
    if (lastKnownImageSrc) {
      const reachedLastImage = await page.evaluate((src) => {
        const img = Array.from(document.images).find((el) => el.src === src);
        if (!img) return false;
        const rect = img.getBoundingClientRect();
        return rect.top < window.innerHeight; // the known last panel has come into view
      }, lastKnownImageSrc);
      if (reachedLastImage) break;
    }
    await page.mouse.wheel(0, scrollStep);
    await page.waitForTimeout(tickMs);
  }
  // A few extra ticks past the last known image so its own settle->capture
  // ->speak cycle (which fires after the scroll that revealed it) actually
  // completes, without continuing to scroll into auto-loaded next-chapter
  // content indefinitely.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(tickMs);
  }
  return ticksUsed;
}

// Runs one read-through session against a single URL: navigates, starts the
// extension on that tab, actively scrolls through the *entire* chapter (see
// scrollThroughFullChapter — real reading simulation start to finish, not a
// partial fixed-time sample), pulls the debug log, and closes the tab.
// Returns a structured result — callers decide how to print/aggregate it.
// minSeconds is a floor, not a target — scrollThroughFullChapter measures
// the real chapter length and extends the budget automatically for chapters
// longer than this covers, up to its own internal hard ceiling.
async function runOneSession(context, background, url, minSeconds, settingsOverride) {
  const settings = { ...DEFAULT_SETTINGS, ...(settingsOverride || {}) };
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push((err.stack || err.message || String(err)).split('\n').slice(0, 5).join(' | ')));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    const startResult = await background.evaluate(
      async ({ url, settings }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url && t.url.startsWith(url.split('?')[0].replace(/\/$/, '')));
        if (!tab) return { ok: false, error: 'tab not found' };
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib-shared/common-words.js', 'lib-shared/reading-order.js', 'content.js'],
        });
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'MVR_INIT', settings });
        return { ok: true, tabId: tab.id, resp };
      },
      { url, settings }
    );

    if (!startResult.ok) {
      return { url, ok: false, error: startResult.error, log: [], pageErrors };
    }

    const tickMs = 4000;
    const minTicks = Math.max(1, Math.round((minSeconds * 1000) / tickMs));
    const ticksUsed = await scrollThroughFullChapter(page, tickMs, minTicks);
    const hitSafetyCap = ticksUsed >= 400;

    let log = [];
    try {
      log = await background.evaluate(async (tabId) => {
        const resp = await chrome.tabs.sendMessage(tabId, { type: 'MVR_GET_LOG' });
        return (resp && resp.log) || [];
      }, startResult.tabId);
    } catch (e) {
      pageErrors.push('log read failed: ' + e.message);
    }

    return { url, ok: true, log, pageErrors, hitSafetyCap };
  } finally {
    await page.close().catch(() => {});
  }
}

function summarizeLog(log) {
  // 'speaking (piper):'/'speaking (attempt' were the old dual-engine log
  // format (MVR_VERSION <=51) — speakOne now always just logs 'speaking:'
  // since there's only one engine. Kept both patterns so this still reports
  // correctly against a log from before that simplification too.
  const spokenLines = log.filter((l) => l.includes('speaking:') || l.includes('speaking (piper):'));
  const systemFallbackLines = log.filter((l) => l.includes('speaking (attempt'));
  const errorLines = log.filter((l) => /ERROR|FATAL/.test(l));
  const orderedLines = log.filter((l) => l.includes('FINAL READING ORDER:'));
  const droppedGarbageLines = log.filter((l) => l.includes('dropped as garbage-shaped'));
  return {
    captures: orderedLines.length,
    piperLines: spokenLines.length,
    systemFallbackLines: systemFallbackLines.length,
    errorLines: errorLines.length,
    errors: errorLines,
    droppedGarbageCount: droppedGarbageLines.length,
  };
}

module.exports = { launchExtensionContext, runOneSession, summarizeLog, DEFAULT_SETTINGS };
