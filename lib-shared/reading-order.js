// Pure logic shared between the extension's content script and the Node
// test harness (tools/test-ocr.js). No browser or chrome.* APIs here, so it
// can run unmodified in both environments — this is what keeps the tester
// honest about what the extension actually does.
//
// Why this reconstructs text from word boxes instead of trusting
// Tesseract's own paragraph/line text: on real manga pages, Tesseract's
// page-segmentation frequently merges two side-by-side speech bubbles that
// happen to sit at the same height into one "paragraph", and reads across
// both of them per text row before moving down — producing lines like
// "APPARENTLY IT'S <huge gap> PRINCESS" / "GOING TO TAKE <huge gap> TOARA
// STILL", i.e. two different characters' lines interleaved word-by-word.
// Rebuilding lines and bubbles from individual word boxes, with an explicit
// horizontal-gap cutoff, avoids that.

function bboxHeight(b) {
  return b.y1 - b.y0;
}
function bboxWidth(b) {
  return b.x1 - b.x0;
}
function unionBbox(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}
function vOverlapRatio(a, b) {
  const top = Math.max(a.y0, b.y0);
  const bottom = Math.min(a.y1, b.y1);
  const overlap = Math.max(0, bottom - top);
  const minH = Math.min(bboxHeight(a), bboxHeight(b));
  return minH > 0 ? overlap / minH : 0;
}
function xOverlapRatio(a, b) {
  const left = Math.max(a.x0, b.x0);
  const right = Math.min(a.x1, b.x1);
  const overlap = Math.max(0, right - left);
  const minW = Math.min(bboxWidth(a), bboxWidth(b));
  return minW > 0 ? overlap / minW : 0;
}
function hGap(a, b) {
  return a.x0 <= b.x0 ? Math.max(0, b.x0 - a.x1) : Math.max(0, a.x0 - b.x1);
}
function vGap(a, b) {
  return a.y0 <= b.y0 ? Math.max(0, b.y0 - a.y1) : Math.max(0, a.y0 - b.y1);
}

// Union-find clustering: groups items where `canMerge(a, b)` holds,
// including transitively (merge chains through intermediate items).
function clusterByProximity(items, canMerge) {
  const parent = items.map((_, i) => i);
  function find(a) {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (canMerge(items[i], items[j])) union(i, j);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it);
  });
  return Array.from(groups.values());
}

// Rejects OCR output that isn't plausible comic dialogue: mis-read
// screentone/panel-border noise tends to come out as symbol soup or
// accidental code-like tokens rather than real words.
function isLikelyGarbage(rawText) {
  const trimmed = rawText.trim();
  // "I" and "a" are the only two legitimate standalone one-letter English
  // words — a bubble that's genuinely just "I" (e.g. trailing off mid-
  // sentence) was getting caught by the length check below and dropped
  // entirely, silently losing real dialogue. Checked before that check,
  // not folded into it, so anything else under 2 characters (stray
  // punctuation/noise) is still correctly rejected.
  const bareLower = trimmed.replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (bareLower === 'i' || bareLower === 'a') return false;
  if (trimmed.length < 2) return true;
  const letters = trimmed.replace(/[^a-zA-Z]/g, '');
  const words = trimmed.split(/\s+/);
  // Common manga interjections ("hmm...", "hmmm...", "um...") are inherently
  // a repeated consonant/vowel run, and OCR sometimes inserts a stray space
  // mid-word ("H M..." instead of "HMM..."). Both shapes otherwise trip the
  // checks below meant for actual garbage: a real "HMMM..." (75% M) hits the
  // same-character-frequency check, and a space-mangled "H M..." hits the
  // isolated-single-letter-words check — confirmed live, both silently
  // dropped extremely common, completely real dialogue. Checked before those
  // rules specifically so this common case never reaches them.
  const noSpaceLower = trimmed.replace(/\s+/g, '').toLowerCase();
  if (/^(?:h*m+|u+m+|u+h+|e+r+|a+h+|o+h+|e+h+)[.…!?]*$/.test(noSpaceLower)) return false;
  // Rescue: a genuinely multi-word bubble that still carries a decent
  // absolute amount of real letters shouldn't be dropped wholesale just
  // because ONE embedded word got badly misread (confirmed live: a
  // stylized/distressed-lettering font PaddleOCR consistently struggles
  // with — deterministic on the same pixels, so a recapture-and-retry can't
  // rescue it either — turned "L-LET" into "1-1E江", tanking the whole
  // bubble's letters/length ratio to 0.45 and silently dropping real
  // dialogue: "L-LET ME GO... IT HURTS...!"). UI-chrome tokens ("Ch. 9.0",
  // "6% · 2/31") stay caught: they're short and nearly all digits/symbols,
  // so their total *letter count* stays low even though the ratio check
  // alone can't tell them apart from a single contaminated word. Single-word
  // noise isn't rescued by this (words.length >= 2 guards that) — for a
  // single stray token, low letter density really is the best signal
  // available.
  const rescued = words.length >= 2 && letters.length >= 5;
  if (letters.length / trimmed.length < 0.55 && !rescued) return true;
  if (letters.length > 3 && !/[aeiouAEIOU]/.test(letters)) return true;
  if (/[{}<>;`]|=>|::|\/\/|\bfunction\b|\bconst\b|\bvar\b|\breturn\b|\bimport\b|\bclass\b/i.test(trimmed)) {
    return true;
  }
  if (words.some((w) => w.replace(/[^a-zA-Z]/g, '').length > 18)) return true;
  // Two or more isolated single-letter "words" (e.g. "D m") essentially
  // never occurs in real dialogue — a real intentionally-spelled-out word
  // uses hyphens with no spaces ("S-A-M-P-L-E"), never bare space-separated
  // single letters. Confirmed live: a page-chrome UI element (unrelated to
  // any manga panel) got OCR'd as two separate single-character detections
  // that happened to land close enough together to cluster into one "bubble"
  // — passed every other check here (short but >=2 chars, decent letter
  // ratio) and, sitting outside every detected panel, its screen position
  // put it first in RTL reading order: the very first thing read on the
  // page was nonsense.
  if (words.length >= 2 && words.every((w) => w.replace(/[^a-zA-Z]/g, '').length <= 1)) return true;
  const freq = {};
  for (const ch of letters.toLowerCase()) freq[ch] = (freq[ch] || 0) + 1;
  const maxFreq = Math.max(0, ...Object.values(freq));
  // Comic lettering commonly repeats a word's last letter for emphasis
  // ("OH... OHHH!", "AHHH!", "NOOO!") — legitimate dialogue, not OCR noise,
  // but it trips a same-character-dominance check meant for actual garbled
  // spam (e.g. misread screentone coming out as "IIIIII"). Confirmed a real
  // instance of this: "OH... OHHH!" (O-H-O-H-H-H, 67% H) was silently
  // dropped from a live capture, which also visibly broke the reading order
  // of everything after it. 0.6 -> 0.7 keeps genuinely degenerate strings
  // caught (those run closer to 0.8-1.0) while letting emphasis lettering
  // through.
  if (letters.length > 4 && maxFreq / letters.length > 0.7) return true;
  return false;
}

// Some reader sites (confirmed live on manganato.gg, branded "Mangakakalot")
// bake a promotional watermark and/or a backup-CDN "Images Server: N /
// Report Error" control directly into the chapter image's own pixels, not a
// removable DOM overlay — since it's part of the image, OCR reads it just
// like any dialogue bubble, and unlike garbled noise it's grammatically
// coherent English, so isLikelyGarbage's ratio/vowel/frequency checks all
// pass it through. Confirmed recurring across multiple real captures on
// this site, always this same handful of phrases, never actual manga
// dialogue. Matched on a few highly distinctive fragments — "images
// server" and "report error" in particular are not phrases a manga
// character would ever plausibly say — normalized for case and the
// inconsistent spacing OCR produces on this UI text ("IMAGESSERVER" vs
// "IMAGES SERVER").
// mangadot.net (2026-08-18, chapter 789407): user reported the extension
// "failing detection" and appearing to freeze on scroll — root-caused via
// the real capture log, not guessed: the very first capture on this site
// picks up a legal disclaimer banner ("All comics on this website are just
// previews of the original comics, there may be many errors in language,
// character names, and storylines.") plus a promotional watermark baked
// into a later panel ("READ ON COMICTOON.net FOR FASTER UPDATE", OCR'd as
// "READ ON C TOON .net FOR FASTER UPDATE" — PaddleOCR split "COMICTOON"
// oddly, hence the loose match below). Both are grammatically coherent
// English, so they sail through isLikelyGarbage same as manganato.gg's
// watermark did. The "freezing" wasn't scrolling actually breaking — it was
// this disclaimer alone queuing 20+ seconds of real speech (confirmed via
// timestamps in the log), during which the extension is correctly busy and
// won't react to a new scroll position yet; it just *felt* broken because
// nothing manga-relevant was happening for that whole stretch.
const READER_CHROME_PATTERNS = [
  /IMAGES?\s*SERVER/,
  /REPORT\s*ERROR/,
  /FAVORITE\s*MANGA\s*SITE/,
  /MANGA\s*READER\s*IN\s*THIS\s*COMMUNITY/,
  /ALL\s*COMICS\s*ON\s*THIS\s*WEBSITE/,
  // Dropped the trailing "COMICS?" requirement (2026-08-18) — confirmed live
  // this exact disclaimer sometimes gets a stray OCR space mid-word ("co
  // mics"), which the old /COMICS?/ (no internal \s*) didn't match, letting
  // the whole disclaimer straight through. "PREVIEWS OF THE ORIGINAL" alone
  // is already distinctive enough not to appear in real dialogue.
  /PREVIEWS?\s*OF\s*THE\s*ORIGINAL\b/,
  // Loose on purpose: OCR misreads this watermark differently every capture
  // (confirmed live — "READ ON C TOON .net" one time, "READO0 C TOON" the
  // next, "N" apparently misread as "0"), so anchoring on the literal
  // "READ ON" letters is too fragile. "READ" followed by "TOON" within a
  // short span, requiring a word boundary before TOON, still won't false-
  // positive on real dialogue mentioning "cartoon"/"platoon" (those have no
  // boundary before "toon" — it's mid-word) or on "read" and "toon"
  // appearing coincidentally far apart in an unrelated sentence.
  /READ.{0,12}\bTOON\b/,
  /FOR\s*FASTER\s*UPDATE/,
  // A second mangadot.net disclaimer, separate from the one above — confirmed
  // live it still reached speech after the first fix (recovery time dropped
  // from ~20s to ~10s, but this one alone still queued ~10s of non-manga
  // speech). "PLEASE BUY THE COMIC" alone is the most distinctive fragment —
  // not something a manga character would plausibly say, unlike "original
  // version" or "available in your," which are too generic on their own.
  /PLEASE\s*BUY\s*THE\s*COMIC/,
  // The same page's one-time "keyboard shortcuts rebindable" onboarding
  // toast got torn into scattered fragments by OCR/reconstruction ("to
  // customise.", "pres", "hle", "Shortcuts a") — only these two fragments
  // are distinctive enough to safely pattern-match without risking a false
  // hit on real dialogue; the others are too short/generic to add safely,
  // left as an accepted residual gap (a one-time onboarding toast, not a
  // per-chapter recurring problem the way the disclaimers above are).
  /\bSHORTCUTS\b/,
  /\bCUSTOMI[SZ]E\.?$/,
];
function isReaderChrome(rawText) {
  const normalized = rawText.toUpperCase().replace(/\s+/g, ' ').trim();
  return READER_CHROME_PATTERNS.some((p) => p.test(normalized));
}

// Manga scanlation sites almost universally watermark a panel with their own
// domain somewhere on it (e.g. "VIOLETSCANS.COM", "MANGANATO.GG") — unlike
// READER_CHROME_PATTERNS above (hand-curated phrases from specific sites'
// surrounding UI chrome), this is site-agnostic: catches any bubble whose
// *entire* text is basically just a bare domain-shaped token, not a curated
// list of known site names. Deliberately whole-line (^...$, no internal
// whitespace allowed) rather than substring — a URL genuinely mentioned
// mid-sentence in real dialogue ("check reddit.com") would still get read,
// only a bubble that's nothing *but* a domain gets dropped. No spaces
// anywhere in the match is what makes this safe against real prose: natural
// sentences don't produce an unspaced word.suffix token, so this doesn't
// need a curated TLD list — any 2-6 letter suffix qualifies, which is what
// lets it catch scanlation domains never seen before without hardcoding
// them. The trailing [a-z0-9]{0,3} tolerates OCR appending a stray letter to
// the TLD (confirmed live: "VIOLETSCANS.COM" misread as "VIOLETSCANS.COMO").
// Requiring a *letter* TLD (not digits) is what keeps chapter/version
// numbers like "CH.9.0" or "V2.5" from matching.
const URL_ONLY_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,6}[a-z0-9]{0,3}$/i;
function isUrlOnly(rawText) {
  return URL_ONLY_PATTERN.test(rawText.trim());
}

// Sound effects/onomatopoeia baked directly into the art (not a clean
// speech bubble) OCR at meaningfully lower confidence than real dialogue —
// confirmed live on a real capture: actual bubble dialogue consistently
// landed 87-100% confidence, while stylized SFX lettering and a small
// clothing-patch label landed 52-78%, even though that still cleared the
// general (much lower) confidence floor used for everything else. A
// dedicated SFX classifier isn't feasible from OCR output alone, but SFX
// is reliably both short (checked live: 1-2 "words" after merging) and in
// that lower confidence band — real short dialogue lines checked in the
// same captures ("Yup!", "MINAMI-KUN!") stayed at 87%+, so this doesn't
// cost genuine short interjections. Left at word-count >= 3 alone
// (unfiltered): a misread bad enough to also tank a multi-word bubble's
// confidence into this range is already caught by the existing
// low-confidence path instead, same as before.
const SFX_MAX_WORDS = 2;
const SFX_MIN_CONFIDENCE = 80;
// Second, independent signal for SFX the confidence check above can't
// catch: crisply, boldly-printed onomatopoeia (as opposed to the
// warped/hand-drawn kind) OCRs at just as high a confidence as real
// dialogue — confirmed live on the same chapter, several of these survived
// the confidence check untouched. Not real English words and not among the
// short-interjection patterns isLikelyGarbage already exempts (hmm/um/uh/
// er/ah/oh/eh), so a curated list is the only lever available, same
// approach already used for READER_CHROME_PATTERNS. Necessarily incomplete
// — SFX vocabulary varies by series/translator — this only ever covers
// what's actually been observed; add to it as new cases turn up rather
// than guessing ahead of time.
const KNOWN_SFX_TOKENS = new Set([
  'biki', 'zun', 'bara', 'hff', 'don', 'shuba', 'waku', 'doki', 'dokun', 'baki', 'zawa', 'gan',
  // Added 2026-08-19, confirmed live on the same chapter's full audit —
  // all survived the confidence check the same way the original batch
  // above did (crisp, boldly-printed lettering).
  'ta', 'su', 'shf', 'beki',
]);
// Stretched-out onomatopoeia ("GYUIIIIIN", "BUSHOAAAA") repeat a vowel an
// arbitrary number of times — exact-matching the full token is fragile
// (confirmed live: a 5-repeated-I spelling didn't match a curated entry
// written with 4) since neither the source lettering nor OCR's read of it
// is guaranteed consistent letter-for-letter. Matched by a short, stable
// prefix instead — safe because no real English word starts with any of
// these specific letter combinations, unlike the short exact-match tokens
// above (a prefix check on "ta" would wrongly also catch "table"/"talk").
const KNOWN_SFX_PREFIXES = ['gyui', 'scree', 'bushoaaaa', 'fwiish'];
// Applies only to the curated-list checks below, not the confidence check
// above — a match against a known SFX token/prefix is a much safer signal
// than "short and low-confidence," so it's fine to tolerate more merged
// trailing fragments (confirmed live: "WAku CPUMPED iae." — three
// whitespace-split "words" after a garbled onomatopoeia cluster merged
// into one bubble — needed this wider allowance; the exact-match token
// itself is still what's actually being trusted, not the word count).
const SFX_TOKEN_MAX_WORDS = 4;
function isLikelySoundEffect(rawText, confidence) {
  const words = rawText.trim().split(/\s+/);
  // A standalone "I" (e.g. trailing off mid-sentence) has very little for
  // OCR to work with and can land at low confidence purely from that, not
  // from being genuinely garbled — the same short-and-low-confidence shape
  // as real SFX, but real dialogue. Checked before that heuristic so it's
  // never dropped by it.
  if (words.length === 1) {
    const bare = words[0].toLowerCase().replace(/[^a-z]/g, '');
    if (bare === 'i' || bare === 'a') return false;
  }
  if (words.length <= SFX_MAX_WORDS && confidence < SFX_MIN_CONFIDENCE) return true;
  if (words.length <= SFX_TOKEN_MAX_WORDS) {
    const firstBare = words[0].toLowerCase().replace(/[^a-z]/g, '');
    if (KNOWN_SFX_TOKENS.has(firstBare)) return true;
    if (KNOWN_SFX_PREFIXES.some((p) => firstBare.startsWith(p))) return true;
  }
  return false;
}

// Step 1: words -> lines. Two words belong to the same line only if their
// vertical centers are close (same baseline) AND they sit close together
// horizontally — a big horizontal gap means "different speech bubble at the
// same height", not "the next word in this line". Comic lettering is often
// set with tight leading, so a same-line/next-line distinction has to use
// center-to-center distance rather than bbox overlap: two stacked lines can
// still have overlapping bounding boxes when the gap between them is small.
function wordsToLines(words, canvasWidth, canvasHeight) {
  function centerY(bbox) {
    return (bbox.y0 + bbox.y1) / 2;
  }
  // Two touching/overlapping speech bubbles (no drawn border between them,
  // e.g. a "double bubble" for simultaneous dialogue) can each have a first
  // line landing at nearly the same height with only a normal-looking word
  // gap between them — centerY-diff and hGap alone can't tell that apart
  // from two real words on one line (confirmed on a real page: "GRAB" (left
  // bubble) and "GONNA" (right bubble, second word of "I'M GONNA") passed
  // both checks and fused into "GRAB GONNA"). The signal that does hold up:
  // each word's *own* bubble reveals itself through its vertical neighbors —
  // GRAB stacks tightly on top of "US A"/"SPOT." below it (strong x-overlap,
  // ~0 vertical gap), GONNA stacks the same way with "I'M" above and "HIT
  // THE" below. Two words that each already belong to an established,
  // multi-word vertical column, but don't x-overlap *each other* at all, are
  // almost certainly different columns/bubbles — real same-line words don't
  // typically also carry independent, size>=2 vertical stacks of their own
  // going in a different direction than each other.
  const columnGroups = clusterByProximity(words, (a, b) => {
    const minH = Math.min(bboxHeight(a.bbox), bboxHeight(b.bbox));
    const maxGap = Math.max(1.3 * minH, 0.015 * canvasHeight);
    return xOverlapRatio(a.bbox, b.bbox) > 0.6 && vGap(a.bbox, b.bbox) < maxGap;
  });
  const columnOf = new Map();
  columnGroups.forEach((group, idx) => group.forEach((w) => columnOf.set(w, { idx, size: group.length })));

  const lineGroups = clusterByProximity(words, (a, b) => {
    const avgH = (bboxHeight(a.bbox) + bboxHeight(b.bbox)) / 2;
    // Tightened from 0.35 to 0.25: two adjacent narrow bubbles' lines can
    // land close enough in both center-Y and horizontal gap to pass the old
    // threshold and fuse into one interleaved "line" (confirmed against a
    // real page where this happened) — real same-line words don't drift
    // this much off the shared baseline, so the tighter bound only excludes
    // genuinely different lines, not legitimate word wrapping.
    if (Math.abs(centerY(a.bbox) - centerY(b.bbox)) > 0.2 * avgH) return false;
    const colA = columnOf.get(a);
    const colB = columnOf.get(b);
    if (colA && colB && colA.idx !== colB.idx && colA.size >= 2 && colB.size >= 2) return false;
    // Adjacent bubbles can sit close enough that the column gap is only
    // ~2x a normal inter-word space, so this has to be tight: normal
    // same-line word gaps run well under one line-height; a gap at or
    // above that is much more likely "next bubble over" than "next word".
    // (Tried tighter — 0.6x — to reduce cross-bubble fusion, but that
    // fractured legitimate lines into fragments too small to survive
    // downstream filtering, which is a worse failure than fusion: it
    // silently drops content instead of just reading it in an odd order.)
    const maxGap = Math.max(1.0 * avgH, 0.01 * canvasWidth);
    return hGap(a.bbox, b.bbox) < maxGap;
  });
  return lineGroups.map((group) => {
    group.sort((a, b) => a.bbox.x0 - b.bbox.x0); // words always read left-to-right within a line
    return {
      bbox: unionBbox(group.map((w) => w.bbox)),
      text: group.map((w) => w.text).join(' '),
      confidence: group.reduce((s, w) => s + (w.confidence || 0), 0) / group.length,
    };
  });
}

// Step 2: lines -> bubbles. Two lines belong to the same speech bubble if
// they're roughly column-aligned (x-overlap) and stacked closely (small
// vertical gap) — this also naturally absorbs a small attached "tail"
// caption line under a main bubble into the same group.
function linesToBubbles(lines, canvasHeight) {
  const groups = clusterByProximity(lines, (a, b) => {
    const minH = Math.min(bboxHeight(a.bbox), bboxHeight(b.bbox));
    const maxGap = Math.max(1.3 * minH, 0.015 * canvasHeight);
    // Require *most* of the narrower line to sit under the wider one — two
    // independent side-by-side bubbles can still graze each other in x, but
    // shouldn't substantially overlap the way wrapped/centered lines in the
    // same bubble do. Two narrow bubbles packed tightly side by side (short
    // lines, small absolute gap) can clear a loose ratio here by accident —
    // and because clustering is transitive, a single false-positive pairing
    // fuses the *entire* two bubbles into one interleaved mess. 0.6 needs
    // lines to actually be mostly stacked on top of each other, not just
    // neighbors, to merge.
    return xOverlapRatio(a.bbox, b.bbox) > 0.6 && vGap(a.bbox, b.bbox) < maxGap;
  });
  return groups.map((group) => {
    group.sort((a, b) => a.bbox.y0 - b.bbox.y0);
    return {
      bbox: unionBbox(group.map((l) => l.bbox)),
      text: group.map((l) => l.text.trim()).join(' '),
      confidence: group.reduce((s, l) => s + (l.confidence || 0), 0) / group.length,
    };
  });
}

function reconstructBubbles(words, canvasWidth, canvasHeight) {
  const lines = wordsToLines(words, canvasWidth, canvasHeight);
  return linesToBubbles(lines, canvasHeight);
}

// Orders bubbles into reading rows using vertical-overlap clustering
// (handles multi-panel manga pages, not just single columns), then orders
// each row right-to-left (manga) or left-to-right (western comics/webtoons).
// This is the within-a-single-panel algorithm — see orderBubbles below for
// the panel-aware wrapper that calls this per-panel instead of over the
// whole page at once.
//
// A bubble that ends up alone in its own row (nothing vertically overlaps it
// enough to cluster) always sorted after every full row above it, regardless
// of where it actually sits horizontally. That's usually fine — most
// singleton rows genuinely are just the next thing further down the page
// (e.g. a name-tag caption well below the last row of dialogue). But a small
// reaction/aside bubble tucked into the horizontal gap between two
// side-by-side bubbles one row up is *also* a singleton row by this
// definition, and reading it dead last instead of second (right after the
// rightmost bubble in the row it's tucked under) is wrong.
//
// Two earlier attempts at distinguishing these (a global pairwise
// comparator; a nearest-neighbor splice using raw center-to-center
// distance) each got validated against real pages and each introduced a
// *new* regression, because distance/overlap alone can't tell "sandwiched
// between two things" apart from "just further down the page" — a
// singleton far below everything can still be the closest thing around by
// raw distance. The distinguishing signal that actually holds up: a bubble
// that's genuinely tucked under a row has a near-zero *vertical gap* to
// that row (it's touching or nearly touching it); a bubble that's simply
// further down the page has a real, visible gap. Splicing only triggers
// when that gap is small relative to the orphan's own height — a name tag
// with a 150px gap above it is left alone; a reaction bubble touching the
// row above it gets inserted into that row's left-right sequence by X.
function orderBubblesFlat(bubbles, direction) {
  const items = bubbles.map((b, i) => ({ b, i }));
  const rows = clusterByProximity(items, (a, b) => vOverlapRatio(a.b.bbox, b.b.bbox) > 0.35);
  rows.forEach((row) =>
    row.sort((a, b) => (direction === 'rtl' ? b.b.bbox.x0 - a.b.bbox.x0 : a.b.bbox.x0 - b.b.bbox.x0))
  );
  rows.sort((a, b) => {
    const ay = Math.min(...a.map((it) => it.b.bbox.y0));
    const by = Math.min(...b.map((it) => it.b.bbox.y0));
    return ay - by;
  });

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== 1) continue;
    const above = rows[i - 1];
    if (!above || above.length < 2) continue; // need a real multi-bubble row to splice into
    const orphan = rows[i][0];
    const aboveBbox = unionBbox(above.map((it) => it.b.bbox));
    const gap = vGap(orphan.b.bbox, aboveBbox);
    const orphanHeight = orphan.b.bbox.y1 - orphan.b.bbox.y0;
    if (gap > 0.5 * orphanHeight) continue; // a real gap: just the next row down, leave it
    rows.splice(i, 1);
    const insertAt = above.findIndex((it) =>
      direction === 'rtl' ? it.b.bbox.x0 < orphan.b.bbox.x0 : it.b.bbox.x0 > orphan.b.bbox.x0
    );
    above.splice(insertAt === -1 ? above.length : insertAt, 0, orphan);
    i--; // re-check this index — a row was removed, so it now holds what followed it
  }

  return rows.flat().map((it) => it.b);
}

// Reconstructs closed panel rectangles from vertical cuts (see
// panel-detect.js — each carries its own confirmed y-extent) whose extents
// substantially agree — a real panel's left and right edges run for
// approximately the same height. Doesn't require a matching top/bottom
// horizontal cut on top of that: two verticals with strongly overlapping
// y-ranges are already good evidence of a shared panel, and a panel touching
// the page's own top/bottom (no separate drawn cap) is common.
//
// Real bug fixed (2026-08-18, confirmed against a real two-panel spread's
// exact coordinates before shipping): the original version paired cuts
// greedily in left-to-right x-order, taking the *first* valid match for each
// cut rather than the *best* one. Real panel edges aren't the only tall,
// well-matched vertical cuts on a page — background art/texture routinely
// produces short, incidental cuts that still pass the 70% overlap bar
// against a genuine tall edge (a short cut fully nested inside a tall one
// always scores a perfect 1.0 overlap ratio, identical to two edges that are
// a real matching pair). Confirmed live: a real panel's left edge got
// "claimed" by an unrelated 170px-tall background-texture cut positioned
// earlier in sort order, before the algorithm ever got to consider pairing
// it with its actual partner — leaving that partner to claim a *different*
// wrong cut in turn. With no correct rectangle formed for either of two
// side-by-side panels, both fell back to un-partitioned flat ordering, and
// a tall caption box's bounding box bridged bubbles from the two different
// panels into one incorrectly-merged reading row (see orderBubbles below).
//
// Now a global greedy match: every valid candidate pair (not just adjacent-
// in-sort-order ones) is considered, ranked by the *shorter* cut's own
// height (tall-tall pairs are far more likely to be genuine panel edges than
// a tall cut paired with a short incidental one), and claimed in that order.
// Candidates whose resulting width would be implausibly narrow for an actual
// panel are rejected outright — this is what stops two adjacent edges of a
// single thin gutter/divider *between* two panels from pairing with each
// other (they'd score a perfect ratio too, but the "panel" between them
// would only be a few px wide) — forcing each gutter edge to instead pair
// with its true outer edge on the other side.
//
// canvasWidth's own left/right boundaries (x=0 and x=canvasWidth) are
// included as two synthetic candidate edges, mirroring the existing
// no-drawn-cap tolerance for horizontal cuts above: a panel that runs to the
// capture's own edge with no separately-drawn border there is common (and
// is exactly what happened here — both panels' *outer* edges were absent
// from the detected cuts entirely, only the shared inner gutter was found).
// The two synthetic edges are never paired with *each other* — that would
// just reconstruct the entire canvas as one meaningless "panel".
const MIN_PANEL_WIDTH_RATIO = 0.08;
function reconstructRectangles(vCuts, canvasWidth) {
  const cuts = canvasWidth
    ? vCuts.concat([
        { x0: 0, y0: 0, x1: 0, y1: Infinity, synthetic: true },
        { x0: canvasWidth, y0: 0, x1: canvasWidth, y1: Infinity, synthetic: true },
      ])
    : vCuts;
  // Synthetic edges carry y1=Infinity so they always fully cover whatever
  // real cut they're tested against, regardless of the actual capture
  // height (unknowable here without also threading canvasHeight through) —
  // safe because minHeight (the overlap ratio's denominator) always comes
  // from the *real* cut in a synthetic/real pairing, never from Infinity.
  const candidates = [];
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const left = cuts[i];
      const right = cuts[j];
      if (left.synthetic && right.synthetic) continue;
      const lo = Math.min(left.x0, right.x0);
      const hi = Math.max(left.x0, right.x0);
      if (canvasWidth && hi - lo < canvasWidth * MIN_PANEL_WIDTH_RATIO) continue;
      const overlap = Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0);
      const minHeight = Math.min(left.y1 - left.y0, right.y1 - right.y0);
      if (overlap <= 0 || minHeight <= 0 || !Number.isFinite(minHeight) || overlap / minHeight < 0.7) continue;
      candidates.push({ i, j, minHeight });
    }
  }
  candidates.sort((a, b) => b.minHeight - a.minHeight);
  const used = new Array(cuts.length).fill(false);
  const rects = [];
  for (const c of candidates) {
    if (used[c.i] || used[c.j]) continue;
    const left = cuts[c.i];
    const right = cuts[c.j];
    rects.push({
      x0: Math.min(left.x0, right.x0),
      x1: Math.max(left.x0, right.x0),
      y0: Math.max(left.y0, right.y0),
      y1: Math.min(left.y1, right.y1),
    });
    used[c.i] = true;
    used[c.j] = true;
  }
  return rects;
}

// Groups bubbles into panels via hard containment inside reconstructed
// rectangles — a bubble whose center falls inside a rectangle belongs to
// that panel, full stop. Bubbles outside every rectangle are each left as
// their own standalone group (orderBubblesFlat's own row-clustering, reused
// one level up in orderBubbles, still sorts multiple such standalone
// bubbles sensibly relative to each other and to the rectangle panels).
//
// A flood-fill approach (connected regions on a grid, walled off by scoped
// cuts) was tried first and doesn't work: with only *some* of a panel's
// sides confirmed (a real border can be occluded by art/text, or just not
// drawn on a borderless/bleed panel), the flood fill leaks through the gap
// where no wall was detected and incorrectly merges two actually-different
// panels into one connected region — confirmed on a real page where a
// bottom-left bubble had no confirmed border directly around it and flowed
// straight into a neighboring panel's region through the open gap between
// them, corrupting that panel's effective bounding box and, with it, the
// RTL ordering of everything relative to it. Hard containment inside an
// explicitly reconstructed rectangle can't leak the same way: a bubble
// either measurably sits inside a confirmed box or it doesn't.
function partitionIntoPanels(bubbles, panelBorders, canvasWidth) {
  const rects = reconstructRectangles(panelBorders.verticalCuts || [], canvasWidth);
  if (!rects.length) return [bubbles];

  const groups = rects.map(() => []);
  const standalone = [];
  bubbles.forEach((b) => {
    const cx = (b.bbox.x0 + b.bbox.x1) / 2;
    const cy = (b.bbox.y0 + b.bbox.y1) / 2;
    const idx = rects.findIndex((r) => cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1);
    if (idx === -1) standalone.push(b);
    else groups[idx].push(b);
  });
  return groups.filter((g) => g.length).concat(standalone.map((b) => [b]));
}

// Panel-aware wrapper: a human finishes every bubble in one panel before
// moving to the next, even if a bubble in a later panel happens to sit at a
// similar height to one in an earlier panel (which is exactly what caused
// the bug this exists to fix — two tall bubbles in *different*, side-by-side
// panels vertically overlapped enough to get clustered into one reading
// row and interleaved, purely because orderBubblesFlat has no concept of
// "panel", only bubble geometry). When real border cuts were detected,
// bubbles are grouped into panels first, the panels themselves ordered as
// if they were bubbles (reusing the exact same row/column logic one level
// up), and then each panel's own bubbles ordered independently within it.
// Falls back to the plain flat ordering whenever no cuts were detected, or
// detection didn't actually produce more than one panel — this only ever
// adds a constraint on top of the existing behavior, never loosens it, so a
// page where border detection finds nothing behaves exactly as before.
function orderBubbles(bubbles, direction, panelBorders, canvasWidth) {
  const hasCuts =
    panelBorders && ((panelBorders.horizontalCuts || []).length || (panelBorders.verticalCuts || []).length);
  if (!hasCuts) return orderBubblesFlat(bubbles, direction);

  const panels = partitionIntoPanels(bubbles, panelBorders, canvasWidth);
  if (panels.length <= 1) return orderBubblesFlat(bubbles, direction);

  const panelPseudoBubbles = panels.map((group, i) => ({ bbox: unionBbox(group.map((b) => b.bbox)), panelIndex: i }));
  const orderedPanels = orderBubblesFlat(panelPseudoBubbles, direction);
  return orderedPanels.flatMap((p) => orderBubblesFlat(panels[p.panelIndex], direction));
}

// '/' and '\\' are always misreads of a stylized "I" in this project's
// captures, never genuine punctuation — confirmed directly (user report,
// 2026-08-19): every slash actually seen has been a misread letter, never
// real slash-separated punctuation like "and/or". An earlier version of
// this fix tried to protect that "and/or" case by leaving a token alone
// whenever every segment around the slash was independently a real
// dictionary word — dropped per that same report, unconditional now, no
// exceptions. Handled as a plain global replace *before* tokenization
// below (not inside the per-token digit-confusion loop) specifically so it
// also catches a slash with no adjacent letters at all — e.g. OCR
// detecting a lone "/" as its own token — which the old per-token version
// missed entirely (it bailed out early on any token with zero letters).
function replaceSlashes(text) {
  return text.replace(/[/\\]/g, 'i');
}

// Fixes a digit misread as its letter lookalike inside an otherwise-alpha
// token (e.g. "S0ON"). A digit embedded in a run of letters is essentially
// never intentional in comic dialogue, unlike a full-letter substitution
// (which can coincidentally turn a legitimate name into a different real
// word — tried and rejected, see reading-order tuning history). Gated on
// the swapped result being an actual dictionary word, so a token that
// isn't really a near-miss (a stray page-number fragment like "144" glued
// to noise) is left alone rather than "corrected" into different noise.
// Unlike the slash case above, an unswapped stray digit just reads as an
// ordinary number word ("s zero s" for "S0S") — odd, but not the jarring
// "slash"-spoken-aloud failure that justified an unconditional swap there,
// so an unconfirmed digit guess still isn't worth the extra risk of
// corrupting a real digit-containing token.
const CHAR_LETTER_MAP = { 0: 'o', 1: 'i', 5: 's', 8: 'b' };
// '1' is genuinely ambiguous between "i" and "l" depending on the exact
// glyph/font, unlike this map's other entries — CHAR_LETTER_MAP's single
// default of 'i' can't express that. Confirmed live: "WI1L" needed the 'l'
// reading ("WILL"), not the default 'i' reading ("WIIL", not a word, so the
// primary swap correctly declined to fire — but left the digit in place
// instead of trying the other plausible reading). Tried only as a fallback,
// after the primary 'i' mapping has already had its chance to confirm
// against the dictionary — this can only ever change behavior for tokens
// where 'i' already failed to produce a real word, so it can't regress any
// currently-correct 'i' case.
const AMBIGUOUS_ALTERNATE_MAP = { 1: 'l' };
const CONFUSABLE_TOKEN_PATTERN = /[A-Za-z0-9]+/g;
function swapChars(lower, map) {
  let swapped = '';
  for (const ch of lower) swapped += map[ch] || ch;
  return swapped;
}
function fixDigitLetterConfusion(text, commonWords) {
  return replaceSlashes(text).replace(CONFUSABLE_TOKEN_PATTERN, (token) => {
    const confusableChars = [...token].filter((ch) => ch in CHAR_LETTER_MAP);
    if (!confusableChars.length || !/[a-zA-Z]/.test(token)) return token;
    const lower = token.toLowerCase();
    const swapped = swapChars(lower, CHAR_LETTER_MAP);
    const restore = (s) => (token === token.toUpperCase() ? s.toUpperCase() : s);
    if (swapped !== lower && commonWords && commonWords.has(swapped)) return restore(swapped);
    if (commonWords && confusableChars.some((ch) => ch in AMBIGUOUS_ALTERNATE_MAP)) {
      const altSwapped = swapChars(lower, { ...CHAR_LETTER_MAP, ...AMBIGUOUS_ALTERNATE_MAP });
      if (altSwapped !== lower && commonWords.has(altSwapped)) return restore(altSwapped);
    }
    return token;
  });
}

// Fixes a specific, common OCR word-fusion pattern: a short function word
// (pronoun, auxiliary verb, conjunction) glued directly onto the next word
// with no space between them. Confirmed live across many real bubbles on
// the same chapter, all the same shape ("DOESHE" -> "DOES HE", "CANEVEN"
// -> "CAN EVEN", "WHENIT'S" -> "WHEN IT'S", "SOCOULD" -> "SO COULD", "ISHE"
// -> "IS HE", "DoYOu" -> "Do YOu"). Root cause confirmed from the raw OCR
// log, not guessed: PaddleOCR's own *detection* stage returns these as a
// single box with one recognized string (e.g. "DOESHE[100](567,423)-
// (693,459)" as one raw word) — there's no bounding-box gap to measure or
// reconstruction-layer logic to fix here, since the extension never
// receives these as two separate words to begin with. This is the same
// class of detection-stage limitation already documented for vertically-
// merged lines, just showing up horizontally for tightly-kerned short words
// instead — a text-insertion fix is the only lever left, the same way
// fixDigitLetterConfusion above is a text-level fix for a different
// detection/recognition-level limitation.
//
// Deliberately narrow to avoid repeating the already-rejected broader
// "dictionary-based misread correction" (which corrupted a real character
// name, "ROMAGNA"->"ROMANA" — context-free correction can't always tell a
// real word from noise). Four gates keep this safe, each added after real
// testing found a real hole in the previous ones — not theoretical caution:
// (1) the candidate prefix must be from a small curated list of common
// short function words, not any dictionary word; (2) the remainder after
// stripping the prefix must *itself* be a recognized short word (see
// SAFE_SHORT_REMAINDERS below — not the general dictionary for this part,
// see why); (3) the whole token must NOT already be a recognized dictionary
// word on its own, protecting real single words that happen to start with
// one of these prefixes; (4) prefixes are tried longest-first so a more
// specific match ("does") is preferred over a shorter one that could also
// technically fit ("do"), avoiding split ambiguity ("doeshe" could
// otherwise split as either "does"+"he" or "doe"+"she" — both real-word
// pairs, but only the first is what the sentence actually says).
//
// This project's word list (common-words.js, ~10k entries from raw web-text
// frequency, not a curated English dictionary) turned out to have two
// distinct kinds of gaps that directly broke an earlier, broader version of
// this fix, confirmed by testing real words against it before shipping:
// - It's contaminated with short non-word abbreviations/codes at exactly
//   the lengths that matter here (394 "2-letter words" include things like
//   "tv", "pm", "hp", "dc", state codes; 664 "3-letter words" include
//   "usa", "dvd", "url", "www", etc.) — trusting it directly for the
//   *remainder* check let "ch" and "re" (both present) validate wrong
//   splits ("THATCH"->"THAT CH", "THEYRE"->"THEY RE"). Fixed by using a
//   small hand-curated SAFE_SHORT_REMAINDERS whitelist instead of the raw
//   dictionary for remainders of 3 letters or fewer, where this
//   contamination actually lives.
// - It's missing some genuinely common real words outright ("apologize"
//   isn't in it, confirmed separately in fixDigitLetterConfusion's history)
//   — including several that happen to be exactly what a curated prefix
//   plus a real remainder would also spell: "onward" (on+ward), "inland"
//   (in+land), "donut" (do+nut), "heal" (he+al), "getaway" (get+away),
//   "notable" (not+able), "whoever" (who+ever), "haddock" (had+dock).
//   Since the "whole token must not already be a word" gate only works when
//   the dictionary actually contains that word, every one of these produced
//   a real, wrong split while this list still included speculative entries
//   beyond what any confirmed real case actually needed. Every prefix tried
//   here that wasn't already proven necessary by a real observed fusion
//   eventually turned up a real collision — not a coincidence, a pattern:
//   with only ~10k words of (patchy) coverage, almost any short common
//   prefix will eventually collide with *some* real word the list doesn't
//   happen to contain. Rather than keep patching individual gaps
//   (unbounded — more exist), the list below is pruned to exactly the five
//   prefixes actually needed by a confirmed real fusion on this chapter,
//   nothing speculative. If a new fusion pattern is reported later, add
//   its specific prefix here and stress-test it the same way (a batch of
//   real words starting with that prefix, checked for wrong splits) before
//   trusting it — don't add prefixes preemptively "because they seem
//   useful," that's exactly how the dropped ones got in.
// "for" added later (2026-08-18), same treatment: confirmed live on a
// *different* chapter/site ("ARUNA'S WISH WAS FORA HORSE...", visually
// confirmed against the actual page as "FOR A HORSE" with normal spacing)
// and stress-tested against 22 real "for"-prefixed words before shipping —
// found and fixed one real collision first ("FORGIVE" → "FOR GIVE", since
// "forgive" wasn't in the dictionary either) by adding the missing word
// rather than dropping the prefix, since "forgive" is plausible, even
// common, dramatic-dialogue content this project can't afford to corrupt.
// "a" was also tried for the same real case's other half ("A WAR" →
// "AWAR") and rejected outright: even after patching known dictionary
// gaps, it broke 6 of 58 real words tested (ASLEEP, AWAIT, AWAKE, ADEPT,
// ACORN, AISLE) — a single-letter prefix is simply too prolific for this
// list's coverage to support safely, confirming the original instinct to
// exclude 1-letter prefixes was correct. "AWAR" stays an accepted gap.
// "saw", "put" added later (2026-08-19), confirmed live on a real chapter
// ("SAWTHE"->"SAW THE", "PUTIT"->"PUT IT") and each individually
// stress-tested against the full ~10k-word dictionary with zero collisions
// before shipping. Three other candidates from the same chapter were tried
// and rejected:
// - "to"/"how" ("TOTELL"->"TO TELL", "HOWI"->"HOW I"): stress-testing found
//   real collisions (TOPICS->"TO PICS", TOWARD->"TO WARD",
//   TONIGHT->"TO NIGHT", HOWEVER->"HOW EVER", HOWTO->"HOW TO") — accepted
//   gaps, same treatment as "AWAR" above, rather than risk corrupting those
//   real words.
// - "it's" ("IT'SNOT"->"IT'S NOT", zero dictionary collisions): rejected
//   for a different reason — coreWord() below truncates every token at its
//   *first* apostrophe before this loop ever runs, so "IT'SNOT"'s core is
//   just "it" (a real word on its own), which trips the "already a real
//   word" bailout before the prefix loop even sees it; the loop itself also
//   matches prefixes against that same truncated `core`, so an
//   apostrophe-containing prefix structurally can never match through this
//   code path regardless of the bailout. Fixing that would mean reworking
//   how every prefix is matched, not just adding one — not worth it for a
//   single observed instance. Accepted gap.
const SHORT_WORD_PREFIXES = ['does', 'when', 'can', 'saw', 'put', 'so', 'is', 'for'].sort(
  (a, b) => b.length - a.length
);

// Curated rather than sourced from the general dictionary — see the comment
// above for why the general list's short entries can't be trusted here.
// Covers ordinary short pronouns/verbs/prepositions that plausibly show up
// as the second half of a fusion, nothing more. 'a'/'i' included even
// though they're single letters — the *only* two legitimate standalone
// one-letter English words, needed for "FOR A" (confirmed live, visually
// verified against the actual page: "ARUNA'S WISH WAS FORA HORSE" should
// read "...FOR A HORSE"). A single-letter remainder can only ever match
// here if it's exactly "a" or "i" — every other letter is absent from this
// set, so this doesn't reopen the broader single-letter-prefix risk that
// got "a" rejected as a *prefix* candidate above (this is a remainder
// check, gated behind one of the five curated prefixes, not a new prefix).
const SAFE_SHORT_REMAINDERS = new Set([
  'a', 'i', 'he', 'it', 'is', 'be', 'we', 'us', 'my', 'so', 'to', 'of', 'or', 'an', 'if', 'am',
  'she', 'her', 'him', 'his', 'its', 'are', 'was', 'has', 'had', 'did', 'not',
  'now', 'out', 'all', 'any', 'but', 'for', 'and', 'can', 'the', 'you', 'our',
]);

function coreWord(w) {
  const idx = w.indexOf("'");
  return (idx === -1 ? w : w.slice(0, idx)).toLowerCase();
}

function isRecognizedRemainder(remainderCore, commonWords) {
  if (remainderCore.length <= 3) return SAFE_SHORT_REMAINDERS.has(remainderCore);
  return commonWords.has(remainderCore);
}

// Exact-match whitelist for specific fused words that need a full prefix
// added to SHORT_WORD_PREFIXES to rescue — "it" itself was tried and
// rejected (stress-testing found "itself" -> "it self", a very common
// word, too costly to risk breaking every time it appears) — but a
// single confirmed word-pair carries none of that collision risk since
// it only ever matches that one exact fused spelling, not every word
// starting with "it". Confirmed live: "ITWAS" (from "/TWAS" after
// fixDigitLetterConfusion's slash-to-i swap above already ran) needed
// this specifically.
const FUSED_WORD_EXACT_FIXES = new Map([['itwas', 'it was']]);

// A bubble's text sometimes wraps across multiple drawn lines and breaks
// mid-word with a trailing hyphen — e.g. a name ending one line as
// "MINAMI-" with its honorific suffix "KUN" starting the next. That's a
// purely typographic line-wrap artifact, not a real spoken pause, so the
// hyphen itself should go — but the two halves are joined with a space,
// not fused into one solid word. Fully fusing them ("MINAMIKUN") was
// tried first and reverted per direct user report, 2026-08-19: Piper's
// phonemizer mangled the novel fused spelling ("Mynanekun" instead of the
// correct sound), since it no longer resembles two recognizable words —
// context-sensitive English letter-to-sound rules are fragile on long
// unfamiliar strings. A space avoids that: each half stays a normal-length
// word the phonemizer already handles correctly, while the hyphen (which
// read as an unwanted pause) is gone.
// Applied as its own pass over the whole string (not per-token like the
// fixes above) since it has to look at two adjacent word-fragments at
// once, whether or not bubble-reconstruction happened to leave a space
// between them.
// Both sides required to be >=3 letters specifically to avoid also
// matching a genuine stutter ("M-M- M-M- MINAMI- KUN...!?", confirmed live
// in this same project's captures) — stutter fragments are 1-2 letters
// repeated, real line-wrapped word halves aren't.
const HYPHEN_LINE_BREAK_PATTERN = /([A-Za-z]{3,})-\s*([A-Za-z]{3,})/g;
function joinHyphenatedLineBreak(text) {
  return text.replace(HYPHEN_LINE_BREAK_PATTERN, '$1 $2');
}

// Piper/Kokoro's phonemizers are English-only — there's no way to give a
// romanized Japanese name genuinely Japanese pronunciation with either
// engine as currently wired up, only nudge the *English* reading closer.
// Confirmed live: "minami" (the letters are correct — see the slash-to-i
// fix above, which was fixing the right letters all along) still read
// with a long-I first syllable ("my-nah-mi") instead of the correct short
// "mih-nah-mi", because a single "i" in an open first syllable commonly
// defaults to long under English letter-to-sound rules (same reason
// "item"/"iron" have a long I). Respelled with a doubled consonant to
// force the standard English closed-syllable/short-vowel reading instead
// (the same orthographic signal that keeps "inn" short) — an educated
// guess based on English spelling conventions, not something verified by
// ear here, so treat as a first attempt to be confirmed by actually
// listening to it, not a guaranteed fix.
// Sourced from lib-shared/name-pronunciations.js (a curated database of
// common Japanese honorifics/given names/surnames, injected alongside this
// file the same way common-words.js is) — passed in rather than read off
// the global directly, same pattern as commonWords throughout this file,
// so this stays testable in isolation (see tools/*.js).
function respellForPronunciation(text, namePronunciations) {
  if (!namePronunciations) return text;
  return text.replace(/[A-Za-z]+/g, (word) => {
    const fix = namePronunciations[word.toLowerCase()];
    if (!fix) return word;
    return word === word.toUpperCase() ? fix.toUpperCase() : fix;
  });
}

const WORD_TOKEN_PATTERN = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
function insertMissingWordSpace(text, commonWords) {
  if (!commonWords) return text;
  return text.replace(WORD_TOKEN_PATTERN, (token) => {
    const exactFix = FUSED_WORD_EXACT_FIXES.get(token.toLowerCase());
    if (exactFix) {
      return token === token.toUpperCase() ? exactFix.toUpperCase() : exactFix;
    }
    // "it's" checked directly against the raw token, before the core-word
    // bailout below: coreWord() truncates at the *first* apostrophe, so a
    // fused "IT'SNOT" gets core "it" — already a real word on its own —
    // which trips that bailout before the general prefix loop even runs,
    // and that loop also matches prefixes against the same truncated
    // core, so an apostrophe-containing prefix can't match through it
    // regardless (confirmed live, this exact case: 2026-08-19). Handled
    // here instead of reworking how every prefix matches; "it's" was
    // already stress-tested with zero dictionary collisions, same bar as
    // the other prefixes below.
    const lowerToken = token.toLowerCase();
    if (lowerToken.length > 4 && lowerToken.startsWith("it's")) {
      const remainderCore = lowerToken.slice(4);
      if (isRecognizedRemainder(remainderCore, commonWords)) {
        return token.slice(0, 4) + ' ' + token.slice(4);
      }
    }
    const core = coreWord(token);
    if (commonWords.has(core)) return token; // already a real word — leave it alone
    for (const prefix of SHORT_WORD_PREFIXES) {
      // Remainder needs >=1 real char (was >=2 until "a"/"i" were added to
      // SAFE_SHORT_REMAINDERS above) — safe because isRecognizedRemainder
      // only accepts a 1-char remainder if it's exactly "a" or "i".
      if (core.length <= prefix.length) continue;
      if (!core.startsWith(prefix)) continue;
      const remainderCore = core.slice(prefix.length);
      if (isRecognizedRemainder(remainderCore, commonWords)) {
        return token.slice(0, prefix.length) + ' ' + token.slice(prefix.length);
      }
    }
    return token;
  });
}

const MVR_LOGIC = {
  isLikelyGarbage,
  isReaderChrome,
  isUrlOnly,
  isLikelySoundEffect,
  reconstructBubbles,
  orderBubbles,
  fixDigitLetterConfusion,
  insertMissingWordSpace,
  joinHyphenatedLineBreak,
  respellForPronunciation,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MVR_LOGIC;
} else {
  (typeof window !== 'undefined' ? window : globalThis).MVR_LOGIC = MVR_LOGIC;
}
