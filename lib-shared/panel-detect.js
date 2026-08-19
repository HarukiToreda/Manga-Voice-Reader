// Pure logic (no browser/DOM APIs — same reasoning as reading-order.js: this
// lets it run identically in the extension and in Node test harnesses)
// for detecting manga panel border lines from a grayscale pixel buffer.
//
// Why this exists: bubble reading order was being computed purely from text
// bounding-box geometry, with no concept of "panel" at all. Two bubbles in
// entirely different panels that happened to vertically overlap enough
// would get clustered into the same reading row and interleaved, even
// though a human reader would finish one whole panel before moving to the
// next. Manga panels are conventionally drawn with solid border lines — a
// real, independent signal for where panel boundaries actually are.
//
// This went through three real-data-driven revisions before landing here
// (each of the first two shipped, then failed a live retest — see the
// project memory for the blow-by-blow). What actually holds up:
//
// 1. Persistent background regions (a reader site's own black letterboxing
//    margins, dark UI header/toolbar) must be excluded before scanning at
//    all — they're dark at nearly *every* row/column, which both inflates
//    naive coverage checks and, worse, can dominate a "longest contiguous
//    dark run" search so badly that the real (shorter, content-scoped)
//    border line never wins. Detected as rows/columns dark across >95% of
//    their full length.
// 2. A real border segment doesn't need to span the *whole* page — a
//    divider between two side-by-side panels in one row only spans that
//    row's height, not the full page height. So candidates are found
//    per-row/per-column, each carrying its own scoped extent, not assumed
//    to run edge-to-edge.
// 3. Candidate segments alone aren't enough to distinguish a real border
//    from incidental dark art (scaffolding beams, motion lines, hair) —
//    on a real captured page, both produce near-identical "long dark run"
//    signatures. The distinguishing signal that actually holds up: a real
//    panel border is a drawn rectangle, so its sides meet *other* border
//    segments (or the page edge) at corners. An isolated segment with no
//    corroborating perpendicular segment nearby is discarded.
//
// Output is a flat list of *scoped* cuts — each one only valid to compare
// two bubbles when both plausibly sit within the region that cut was
// actually confirmed in (see crossesScopedBorder in reading-order.js) —
// not global page-spanning grid lines.

function findBorderBands(gray, width, height, options) {
  const darkThreshold = (options && options.darkThreshold) || 60;
  const backgroundCoverage = (options && options.backgroundCoverage) || 0.95;
  const minSegmentLength = (options && options.minSegmentLength) || 80;
  const maxThickness = (options && options.maxThickness) || 30;
  const cornerTolerance = (options && options.cornerTolerance) || 20;

  function isDark(x, y) {
    return gray[y * width + x] < darkThreshold;
  }

  // Step 1: exclude persistent background rows/columns (letterboxing, UI
  // chrome) from candidate scanning entirely.
  const bgRows = new Set();
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) if (isDark(x, y)) dark++;
    if (dark / width > backgroundCoverage) bgRows.add(y);
  }
  const bgCols = new Set();
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) if (isDark(x, y)) dark++;
    if (dark / height > backgroundCoverage) bgCols.add(x);
  }
  const xs = [];
  for (let x = 0; x < width; x++) if (!bgCols.has(x)) xs.push(x);
  const ys = [];
  for (let y = 0; y < height; y++) if (!bgRows.has(y)) ys.push(y);

  // Longest contiguous run of "dark" positions among a restricted coordinate
  // list (already background-excluded), returning that run's real extent.
  function longestRun(coords, darkAt) {
    let best = null;
    let curStart = null;
    for (let i = 0; i <= coords.length; i++) {
      const dark = i < coords.length && darkAt(coords[i]);
      if (dark) {
        if (curStart === null) curStart = i;
      } else if (curStart !== null) {
        const len = coords[i - 1] - coords[curStart] + 1;
        if (!best || len > best.len) best = { a: coords[curStart], b: coords[i - 1], len };
        curStart = null;
      }
    }
    return best;
  }

  // Step 2: per-row/per-column candidate segments meeting the minimum
  // length, each carrying its own real extent (not assumed full-span).
  const hCandidates = [];
  for (const y of ys) {
    const run = longestRun(xs, (x) => isDark(x, y));
    if (run && run.len >= minSegmentLength) hCandidates.push({ y, x0: run.a, x1: run.b });
  }
  const vCandidates = [];
  for (const x of xs) {
    const run = longestRun(ys, (y) => isDark(x, y));
    if (run && run.len >= minSegmentLength) vCandidates.push({ x, y0: run.a, y1: run.b });
  }

  // Collapse adjacent same-extent rows/columns into a single band (a real
  // border line has some thickness) — reject anything too thick to
  // plausibly be a drawn line rather than a large dark region.
  function collapse(candidates, posKey, aKey, bKey) {
    const sorted = candidates.slice().sort((s1, s2) => s1[posKey] - s2[posKey]);
    const bands = [];
    let cur = null;
    for (const s of sorted) {
      const extentMatches = cur && Math.abs(s[aKey] - cur[aKey]) < cornerTolerance && Math.abs(s[bKey] - cur[bKey]) < cornerTolerance;
      if (cur && s[posKey] === cur.posEnd + 1 && extentMatches) {
        cur.posEnd = s[posKey];
        cur[aKey] = Math.min(cur[aKey], s[aKey]);
        cur[bKey] = Math.max(cur[bKey], s[bKey]);
      } else {
        if (cur) bands.push(cur);
        cur = { posStart: s[posKey], posEnd: s[posKey], [aKey]: s[aKey], [bKey]: s[bKey] };
      }
    }
    if (cur) bands.push(cur);
    return bands.filter((b) => b.posEnd - b.posStart + 1 <= maxThickness);
  }
  const hBands = collapse(hCandidates, 'y', 'x0', 'x1').map((b) => ({ y0: b.posStart, y1: b.posEnd, x0: b.x0, x1: b.x1 }));
  const vBands = collapse(vCandidates, 'x', 'y0', 'y1').map((b) => ({ x0: b.posStart, x1: b.posEnd, y0: b.y0, y1: b.y1 }));

  // Step 3: corner validation — keep a band only if at least one endpoint
  // meets the page edge, or meets another band running perpendicular to it.
  function nearEdge(v, max) {
    return v <= cornerTolerance || v >= max - cornerTolerance;
  }
  const confirmedH = hBands.filter((hBand) => {
    if (nearEdge(hBand.x0, width) || nearEdge(hBand.x1, width)) return true;
    return vBands.some((v) => {
      const xNear = Math.abs(v.x0 - hBand.x0) < cornerTolerance || Math.abs(v.x0 - hBand.x1) < cornerTolerance;
      const yNear = hBand.y0 >= v.y0 - cornerTolerance && hBand.y0 <= v.y1 + cornerTolerance;
      return xNear && yNear;
    });
  });
  const confirmedV = vBands.filter((vBand) => {
    if (nearEdge(vBand.y0, height) || nearEdge(vBand.y1, height)) return true;
    return hBands.some((h) => {
      const yNear = Math.abs(h.y0 - vBand.y0) < cornerTolerance || Math.abs(h.y0 - vBand.y1) < cornerTolerance;
      const xNear = vBand.x0 >= h.x0 - cornerTolerance && vBand.x0 <= h.x1 + cornerTolerance;
      return yNear && xNear;
    });
  });

  return { horizontalCuts: confirmedH, verticalCuts: confirmedV };
}

const MVR_PANELS = { findBorderBands };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MVR_PANELS;
} else {
  (typeof window !== 'undefined' ? window : globalThis).MVR_PANELS = MVR_PANELS;
}
