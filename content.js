// Haruki's Manga Voice Reader - content script
// Injected on demand (via the popup) into the active tab. On a plain timer,
// captures + OCRs whatever is currently visible and reads it aloud, in
// panel reading order. Won't repeat while sitting still in one spot (gated
// on scroll position, not OCR text — OCR output isn't perfectly stable
// capture to capture, so comparing text caused it to loop on its own
// noise), but keeps no longer-term history — scrolling back to something
// already read plays it again.

(function () {
  const MVR_VERSION = 104;
  // A previous injection's `data-mvr-observed` markers live on the actual
  // DOM elements, not in this closure — if the script runs again (repeat
  // "Start reading" click, or an update while the tab was never fully
  // reloaded) without this, every image looks "already tracked" to the new
  // instance and nothing is ever picked up. Tear down the old instance
  // (listeners, timers, overlay) and clear those markers before doing
  // anything else.
  if (window.__mvrTeardown) {
    try {
      window.__mvrTeardown();
    } catch (e) {
      // ignore
    }
  }
  document.querySelectorAll('img[data-mvr-observed]').forEach((img) => {
    delete img.dataset.mvrObserved;
  });
  window.__mvrVersion = MVR_VERSION;

  // Built once from lib-shared/common-words.js (injected alongside this
  // script) — used only to gate fixDigitLetterConfusion's digit->letter
  // swaps and insertMissingWordSpace's fused-word splitting against real
  // words, not for any broader spell-correction (tried and rejected: too
  // prone to corrupting legitimate character/place names).
  const commonWordsSet = typeof MVR_COMMON_WORDS !== 'undefined' ? new Set(MVR_COMMON_WORDS) : null;

  const STATE = {
    enabled: true,
    ttsEngine: 'piper', // 'piper' or 'kokoro'
    piperVoiceId: 'en_US-hfc_female-medium',
    kokoroVoiceId: 'af_heart',
    direction: 'rtl', // 'rtl' (manga default) or 'ltr' (western comics/webtoons)
    minImgSize: 320,
    minConfidence: 45,
    autoScrollSpeed: 140, // px/sec — user-configurable via the popup slider, see AUTOSCROLL_MIN/MAX_SPEED_PX_PER_SEC for the clamped range actually used
    volume: 100, // 0-100, applied at playback time on top of offscreen.js's own loudness normalization
    status: 'idle',
  };

  const speechQueue = []; // { text, newBubble } chunks ready to speak, in reveal order
  let speaking = false;
  let lastSpokenText = null;
  // Full joined text of the last thing actually read — used only to detect
  // a captured-a-stuck-overlay coincidence in recognizeVisiblePanel, not for
  // the "already read this spot" dedup gate (that's position-based; see
  // lastReadPosition below for why comparing OCR text there was rejected).
  let lastReadText = null;
  let stopRequested = false;
  let capturing = false;
  let totalSpoken = 0;
  // ---------------- autoscroll ----------------
  // v4 design: same continuous-glide-plus-probe idea as v3 (see project
  // memory for why v1/v2's step-then-pause approach was abandoned), but
  // driven by a manual requestAnimationFrame loop at a fixed, precisely
  // controlled px/second rate instead of the browser's own
  // `scrollTo(..., {behavior:'smooth'})`. Confirmed live that the browser's
  // smooth-scroll caps total *duration* rather than scaling speed with
  // distance — even a "modest" 2500px lookahead segment still covered that
  // distance in well under a second (~3000+ px/sec), which was both too
  // fast to actually see the panels passing by and, worse, fast enough
  // that real text could scroll through the viewport *between* two 700ms-
  // spaced probes without ever being caught at all. A manual per-frame
  // `scrollBy` at a fixed rate sidesteps the browser's own duration/easing
  // heuristics entirely — speed is just a number, not something a distance-
  // dependent animation curve decides for you.
  let autoScrolling = false;
  // Whether the glide loop is actively moving right now, as opposed to
  // frozen (probe found text, or actively reading/waiting to resume).
  let autoScrollGliding = false;
  let autoScrollRAF = null;
  let autoScrollLastFrameTs = null;
  // How fast the page actually moves through blank stretches — deliberately
  // slow by default: fast enough to not feel tedious, slow enough that (a) a
  // human can actually see the panels go by (the original ask) and (b) a
  // piece of text has several probe opportunities while it's in view rather
  // than sliding through the whole viewport between two probes and never
  // being caught (confirmed live: too-fast gliding was silently skipping
  // real dialogue, not just feeling fast). User-adjustable via the popup's
  // speed slider (STATE.autoScrollSpeed) — clamped to this range so a wildly
  // out-of-bounds stored/injected value can't reproduce that dropped-content
  // failure mode; AUTOSCROLL_PROBE_INTERVAL_MS below was tuned against the
  // 140 default, so the max here is deliberately conservative rather than
  // "however fast scrollBy can go."
  const AUTOSCROLL_MIN_SPEED_PX_PER_SEC = 60;
  const AUTOSCROLL_MAX_SPEED_PX_PER_SEC = 280;
  function autoScrollSpeed() {
    const v = Number(STATE.autoScrollSpeed);
    if (!Number.isFinite(v)) return 140;
    return Math.min(AUTOSCROLL_MAX_SPEED_PX_PER_SEC, Math.max(AUTOSCROLL_MIN_SPEED_PX_PER_SEC, v));
  }

  // chrome.tabs.captureVisibleTab returns the screenshot at the tab's actual
  // *device*-pixel resolution (the OCR result's own `width`/`height`), not
  // CSS pixels — on any display with devicePixelRatio != 1 (common on
  // higher-res/scaled monitors, e.g. Windows set to 125%/150% scaling) those
  // differ, and every bbox y-coordinate ends up systematically off from
  // window.innerHeight/scrollY (both always CSS-pixel) by that same factor.
  // Confirmed as the cause of a real user report — on a larger/scaled
  // screen, autoscroll's reposition-to-top glide overshot dramatically
  // ("puts the new discovered letters far past the screen and cuts off")
  // because a device-pixel topY was being used directly as if it were
  // already CSS-pixel. This was never caught by testing here because
  // Playwright's default profile runs at devicePixelRatio 1, where the two
  // coincide exactly and the bug is invisible. Scale is measured directly
  // from the actual captured canvas height vs. the actual viewport height,
  // rather than trusting window.devicePixelRatio — more robust to whatever
  // Chrome's real capture behavior turns out to be (zoom level, etc.).
  function deviceYToCssY(deviceY, canvasHeight) {
    return canvasHeight ? deviceY * (window.innerHeight / canvasHeight) : deviceY;
  }
  let autoScrollTimer = null;
  // Fast, responsive poll for state checks (busy? time to probe or resume?)
  // — cheap, so no reason for this to be coarse.
  const AUTOSCROLL_POLL_MS = 100;
  // Throttles actual OCR probes specifically (each one is a real
  // captureVisibleTab + recognition round trip, not free, and Chrome rate-
  // limits captureVisibleTab) — independent of both the poll rate above and
  // the glide's own frame rate. At 140px/sec a probe every 700ms means the
  // page moves ~100px between checks — several probe opportunities before
  // a given bubble (typically 150-300px tall) scrolls out of view.
  const AUTOSCROLL_PROBE_INTERVAL_MS = 700;
  let autoScrollLastProbeAt = 0;
  // Set to the *final* read position once runCaptureOCR actually finishes
  // reading something (after any reposition-to-top correction) — not the
  // probe's own freeze point, which may still move once the real capture
  // gets a proper look at it. Used both to know when a "just finished
  // reading, pause before resuming" phase applies, and as the anchor
  // autoScrollMinAdvancePx() measures forward progress from.
  let autoScrollLastContentPosition = null;
  // Must glide at least this far past the last read position before
  // probing resumes — otherwise the very first probe after resuming would
  // immediately re-find the content that was just read (still filling most
  // of the viewport) and freeze right back on top of it. Expressed as a
  // ratio of the actual viewport height (~0.75, matched to the 550px value
  // validated against a ~720px-tall test window) rather than a fixed px
  // count — a fixed px count tuned to one window size under-advances (re-
  // probes too soon, risking the exact duplicate-read bug this constant
  // exists to prevent) on a shorter browser window, and over-advances
  // (skips past content unnecessarily) on a taller one.
  const AUTOSCROLL_MIN_ADVANCE_RATIO = 0.75;
  function autoScrollMinAdvancePx() {
    return window.innerHeight * AUTOSCROLL_MIN_ADVANCE_RATIO;
  }
  // Brief pause after finishing a read before resuming the glide, in case
  // a closely-following bubble is still settling in nearby.
  const AUTOSCROLL_CONTENT_GRACE_MS = 1200;
  let autoScrollIdleSince = 0;
  // How long to hold off re-gliding after a probe freezes the glide, before
  // the real settle-triggered capture pipeline (maybeCapture/runCaptureOCR)
  // has had a chance to notice the stopped position and take over. Without
  // this, the very next 100ms tick sees "not gliding" + "not busy yet" +
  // "no confirmed read position yet" and immediately restarts the glide,
  // racing ahead of settle detection (SETTLE_MS=350 plus the ~200ms
  // speculative window) — confirmed live: this caused autoscroll to
  // oscillate forever on the first bit of text it found (re-probing,
  // re-freezing on the same text) without ever completing a real read.
  // Comfortably longer than SETTLE_MS + one poll cycle.
  const AUTOSCROLL_RESUME_GRACE_MS = 600;
  // If the first text a capture finds starts below this fraction of the
  // viewport's height, it's low enough in frame to be worth repositioning
  // toward the top before reading (see the check in runCaptureOCR) rather
  // than reading it wherever the glide happened to freeze.
  const AUTOSCROLL_REPOSITION_THRESHOLD_RATIO = 0.35;
  // How far below the top edge the found text's own bbox lands after
  // repositioning. This needs to be more than a tight crop-to-the-text
  // margin: a speech bubble's drawn outline/tail extends visibly above and
  // around the OCR'd text itself, so a small margin (originally a fixed
  // 60px) left the bubble's own top edge cut off by the viewport even
  // though the text bbox was technically "near the top" — user-reported.
  // Scales with viewport height (like autoScrollMinAdvancePx) rather than a
  // fixed px count, clamped so it stays sane on very short/tall windows.
  const AUTOSCROLL_REPOSITION_MARGIN_RATIO = 0.12;
  const AUTOSCROLL_REPOSITION_MARGIN_MIN_PX = 60;
  const AUTOSCROLL_REPOSITION_MARGIN_MAX_PX = 160;
  function autoScrollRepositionMarginPx() {
    return Math.min(
      AUTOSCROLL_REPOSITION_MARGIN_MAX_PX,
      Math.max(AUTOSCROLL_REPOSITION_MARGIN_MIN_PX, window.innerHeight * AUTOSCROLL_REPOSITION_MARGIN_RATIO)
    );
  }
  // Scroll position, not OCR text, is the "have I already read this spot"
  // signal — OCR output for a genuinely-unchanged view isn't perfectly
  // stable capture to capture (confirmed from real logging: identical
  // scroll position produced visibly different text between two captures
  // seconds apart), so comparing text caused it to treat its own noise as
  // "new" content and loop forever. Scroll position is exact and free of
  // that problem. See currentPositionSignal() for why this isn't literally
  // window.scrollY.
  let lastReadPosition = null;
  // Tracks when the position signal last actually changed, so "settled" can
  // be defined as "unchanged for SETTLE_MS", independent of how often
  // maybeCapture() itself polls — separate from lastReadPosition, which
  // tracks the last position actually read. Previously settle detection was
  // just "unchanged since the last 700ms poll", which meant up to ~1.4s of
  // pure waiting after the user actually stopped scrolling before a capture
  // even started (needed two matching polls, each up to 700ms apart).
  // Decoupling the two lets the poll run often (cheap — one
  // getBoundingClientRect-based read) while still filtering out the brief
  // pauses inertial/trackpad scrolling produces mid-scroll.
  let lastPollPosition = null;
  let lastPositionChangeTime = 0;
  const SETTLE_MS = 350;
  // Tracks which position a speculative early capture has already been
  // dispatched for, so it fires once per still position rather than once
  // per poll tick — see the speculative branch in maybeCapture below.
  let lastSpeculativeAttemptPosition = null;

  // Rolling log the popup can pull and display directly (MVR_GET_LOG) —
  // so what's actually happening is visible without opening DevTools.
  const logBuffer = [];
  // Each capture produces several entries (raw words, bubble list, kept
  // count, final order, plus one line per spoken sentence) — with 6+
  // bubbles per panel that's 15-20 entries per capture, so a small cap
  // loses whole captures' worth of history within a couple minutes of
  // reading. Text log entries are cheap in memory; keep a lot of them.
  const MAX_LOG = 3000;
  function logEvent(text) {
    console.log("[Haruki's Manga Voice Reader]", text);
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    logBuffer.push(`[${stamp}] ${text}`);
    if (logBuffer.length > MAX_LOG) logBuffer.shift();
  }

  // ---------------- status overlay ----------------

  // Interactive, not just a status readout — Read forces an immediate
  // capture of whatever's currently visible, Pause is a quick in-page pause
  // (see pauseReading() — deliberately lighter than the popup's Stop: a
  // page refresh resumes reading normally rather than staying off),
  // Autoscroll drives the page for you (see startAutoScroll()), so all
  // three common actions are reachable without opening the popup at all.
  function ensureOverlay() {
    let el = document.getElementById('mvr-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mvr-overlay';
    el.className = 'mvr-idle';
    el.innerHTML =
      '<div id="mvr-dot"></div>' +
      '<div id="mvr-text">Ready</div>' +
      '<button id="mvr-read-btn" type="button" title="Read visible panels now">Read</button>' +
      '<button id="mvr-autoscroll-btn" type="button" title="Automatically scroll through the page, pausing while each panel is read">Autoscroll</button>' +
      '<button id="mvr-pause-btn" type="button" title="Pause reading (refresh the page to resume normally)">Pause</button>';
    (document.body || document.documentElement).appendChild(el);
    // 'mousedown', not 'click' — manga sites are routinely ad-heavy, and
    // some ad networks hijack the pointer-up/click moment page-wide to pop
    // a new tab (confirmed live: a real ad payload here was explicitly
    // tagged `"pt":"tabup"`, i.e. triggered on pointer-up). Since 'click'
    // only fires *after* pointerup/mouseup, a page-wide pointerup listener
    // registered before this content script even loaded can act first and
    // swallow the interaction before our own 'click' handler ever runs —
    // reproduced live as the overlay button doing nothing at all.
    // 'mousedown' fires earlier in the sequence (mousedown -> mouseup ->
    // click), landing our handler before that hijack point.
    el.querySelector('#mvr-read-btn').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      readNow();
    });
    el.querySelector('#mvr-autoscroll-btn').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (autoScrolling) stopAutoScroll();
      else startAutoScroll();
    });
    el.querySelector('#mvr-pause-btn').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      pauseReading();
    });
    return el;
  }

  function setStatus(status, text) {
    STATE.status = status;
    const el = ensureOverlay();
    el.className = 'mvr-' + status;
    const t = el.querySelector('#mvr-text');
    if (t) {
      t.textContent =
        text ||
        {
          idle: 'Idle',
          scanning: 'Reading…',
          speaking: 'Speaking…',
          error: 'Could not read that panel',
        }[status] ||
        '';
    }
  }

  // ---------------- lightweight "is there manga content on screen" gate ----------------
  // Screenshot capture + OCR isn't free, so before doing it we do a cheap
  // check that at least one sufficiently large image is actually visible,
  // to avoid burning cycles on nav bars, comment sections, ads, etc.

  function imgKey(img) {
    return img.currentSrc || img.src || img.dataset.mvrId;
  }

  function isEligibleImage(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return w >= STATE.minImgSize && h >= STATE.minImgSize;
  }

  const knownImages = new Set();

  function isInViewport(img, margin) {
    const m = margin || 0;
    const r = img.getBoundingClientRect();
    return r.bottom > -m && r.top < window.innerHeight + m && r.right > 0 && r.left < window.innerWidth;
  }

  function hasVisibleManga() {
    for (const img of knownImages) {
      if (isEligibleImage(img) && isInViewport(img, 0)) return true;
    }
    return false;
  }

  // "Has the view changed since the last read" signal, used instead of
  // window.scrollY. Combines two independent things, either of which alone
  // misses a real case:
  //  - Position (getBoundingClientRect().top of the topmost visible tracked
  //    image) — reflects an element's true on-screen position regardless of
  //    *which* ancestor is scrolling, so it works whether a site scrolls the
  //    window or an inner container (some custom reader UIs do the latter;
  //    window.scrollY stays frozen at 0 on those forever, permanently
  //    locking the dedup check after the very first read).
  //  - Image identity (its src) — some readers page through content by
  //    swapping the same <img> element's src in place rather than moving it
  //    (traditional page-by-page viewers, not continuous-scroll strips); the
  //    position never changes at all there, only the content does.
  // Together these cover continuous-scroll, inner-container-scroll, and
  // swap-in-place pagination without needing to know which one a given site
  // uses.
  function currentViewSignal() {
    let best = null;
    for (const img of knownImages) {
      if (!isEligibleImage(img) || !isInViewport(img, 0)) continue;
      const top = img.getBoundingClientRect().top;
      if (best === null || top < best.top) best = { top: Math.round(top), key: imgKey(img) };
    }
    return best;
  }
  function currentPositionSignal() {
    const v = currentViewSignal();
    return v ? `${v.top}::${v.key}` : null;
  }

  // Position strings are "{top}::{imageKey}" (above) — two positions count
  // as "the same spot" if they're the same tracked image AND their top
  // values are within a small tolerance, not just an exact match. Exact-
  // match dedup was the original design (position, not OCR text,
  // deliberately — see currentPositionSignal's own history for why text-
  // based dedup was rejected), but it turned out too strict in practice:
  // confirmed live, a few px of *incidental* scroll drift while reading
  // (not a deliberate scroll-back) was enough to count as "a new position,"
  // re-triggering a fresh capture of essentially the same bubble — and OCR
  // isn't perfectly stable capture-to-capture even for near-identical crops,
  // so that second capture sometimes came out *worse* than the first
  // (confirmed: "...FORWARD TO IT!" read correctly once, then ~100px of
  // drift produced "...FORWARD TO t!" on the very next capture of the same
  // bubble). A small tolerance absorbs that jitter while still re-reading
  // anything the user deliberately scrolls back further to revisit.
  const POSITION_DEDUP_TOLERANCE_RATIO = 0.15;
  function positionsMatch(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    const sepA = a.indexOf('::');
    const sepB = b.indexOf('::');
    const keyA = a.slice(sepA + 2);
    const keyB = b.slice(sepB + 2);
    if (keyA !== keyB) return false;
    const topA = Number(a.slice(0, sepA));
    const topB = Number(b.slice(0, sepB));
    return Math.abs(topA - topB) <= window.innerHeight * POSITION_DEDUP_TOLERANCE_RATIO;
  }

  function maybeTrack(img) {
    if (img.dataset.mvrObserved) return;
    img.dataset.mvrObserved = '1';
    if (img.complete && img.naturalWidth > 0) {
      knownImages.add(img);
    } else {
      img.addEventListener('load', () => knownImages.add(img), { once: true });
    }
  }

  function scanForImages(root) {
    if (!root) return;
    if (root.tagName === 'IMG') maybeTrack(root);
    if (root.querySelectorAll) root.querySelectorAll('img').forEach(maybeTrack);
  }

  scanForImages(document.body);
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) scanForImages(n);
      });
    }
  });
  mo.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // ---------------- OCR (PaddleOCR, run in the background service worker) ----------------

  // captureVisibleTab screenshots literally everything painted in the tab —
  // including our own status pill. It used to be hidden for the moment of
  // each screenshot to keep its own text out of OCR results, but that
  // caused real, user-reported flicker/disappearing — the overlay now stays
  // visible at all times, and finalizeReading's excludeOverlayBubbles keeps
  // its text out of results by screen position instead (double rAF below is
  // still needed for other pending DOM updates to actually paint before the
  // capture happens, unrelated to the overlay).
  // 20s timeout mirrors speakTtsOnce's — a dropped response here would
  // otherwise leave `capturing` stuck true forever, same class of wedge.
  const OCR_RESPONSE_TIMEOUT_MS = 20000;
  // The overlay used to be hidden for the moment of each screenshot (so its
  // own "Read"/"Autoscroll"/status text never got captured/OCR'd) — user
  // reported it flashing away and not reliably coming back, and asked for
  // it to just always stay visible instead. It now stays on screen through
  // every capture; excludeOverlayBubbles (see finalizeReading) keeps its
  // own text out of OCR results by screen position instead of by hiding it.
  function requestOcrCapture() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`no response from background/offscreen within ${OCR_RESPONSE_TIMEOUT_MS}ms`));
      }, OCR_RESPONSE_TIMEOUT_MS);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Measured right here, immediately before the message that
          // triggers the actual screenshot — not later when the result
          // comes back. The overlay auto-sizes to its own content (status
          // text, "Autoscroll"/"Stop Scroll" label) and can genuinely be a
          // different size/position by the time OCR finishes (500ms-3s+
          // later) than it was in the screenshot itself; a rect queried
          // fresh in finalizeReading was confirmed live to miss the
          // overlay's actual captured position because of exactly that
          // drift, letting its own button text ("Pause", "Stop Scroll")
          // reach speech during autoscroll. This rect reflects what was
          // truly on screen at the moment the pixels were captured.
          const overlay = document.getElementById('mvr-overlay');
          const overlayRect = overlay ? overlay.getBoundingClientRect() : null;
          // Same reasoning, same moment-of-screenshot timing as overlayRect
          // above — the actual manga image(s) currently on screen, so
          // anything OCR'd outside all of them (site header/nav, chapter-
          // selector chrome, "You're reading X at Y.com" disclaimers,
          // comments, a synopsis page's own description text, etc.) can be
          // excluded the same way — see excludeOutsideImages.
          const imageRects = [...knownImages]
            .filter((img) => isEligibleImage(img) && isInViewport(img, 0))
            .map((img) => img.getBoundingClientRect());
          chrome.runtime.sendMessage({ type: 'MVR_OCR_CAPTURE' }, (resp) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!resp || resp.error) {
              reject(new Error((resp && resp.error) || 'capture failed'));
              return;
            }
            resolve({ ...resp, overlayRect, imageRects });
          });
        });
      });
    });
  }

  // Splits bubble text into sentence-sized speech chunks (so a TTS cutoff
  // loses at most one sentence, not a whole bubble — see speakOne). A
  // naive split on [.!?] is dangerous on OCR output: a stylized word
  // Tesseract misreads with a stray period inserted between letters (e.g.
  // "RETREATED" garbled into "R.E.T.R.E.A...") would otherwise produce a
  // run of single-letter "sentences" that get spoken as isolated letters —
  // audibly spelled out instead of read as a word. Buffering fragments
  // until they reach a minimum length prevents that regardless of why the
  // stray period is there.
  function splitIntoSentences(text) {
    const raw = (text.match(/[^.!?]+[.!?]*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    const chunks = [];
    let buffer = '';
    raw.forEach((part) => {
      buffer = buffer ? buffer + ' ' + part : part;
      if (buffer.length >= 4) {
        chunks.push(buffer);
        buffer = '';
      }
    });
    if (buffer) {
      if (chunks.length) chunks[chunks.length - 1] += ' ' + buffer;
      else chunks.push(buffer);
    }
    return chunks;
  }

  // One capture+OCR+reconstruct pass. Real logging (back when this ran on
  // Tesseract) proved the same on-screen content could OCR cleanly in one
  // capture and come out badly garbled in the next — genuine capture-to-
  // capture instability, not a grouping bug. Keeping the average-confidence
  // score lets the caller detect a bad draw and retry rather than
  // committing to reading garbage; PaddleOCR has proven far more stable
  // capture-to-capture in testing, but the retry safety net is cheap to
  // keep either way.
  async function captureAndRecognize() {
    const { words, width, height, panelBorders, overlayRect, imageRects } = await requestOcrCapture();
    // Bounding boxes included (not just text) so geometry-sensitive bugs
    // (bubble fusion, reading order) can be diagnosed from a pasted log
    // alone — including on sites this can't fetch and re-test against
    // directly (e.g. behind a bot-detection challenge).
    const fmtBox = (b) => `(${Math.round(b.x0)},${Math.round(b.y0)})-(${Math.round(b.x1)},${Math.round(b.y1)})`;
    logEvent(
      `Raw words (${words.length}, canvas ${width}x${height}): ` +
        words.map((w) => `${w.text}[${w.confidence.toFixed(0)}]${fmtBox(w.bbox)}`).join(' ')
    );
    const rawBubbles = MVR_LOGIC.reconstructBubbles(words, width, height);
    logEvent(
      `OCR found ${rawBubbles.length} raw bubble(s): ` +
        rawBubbles.map((b) => `[${b.confidence.toFixed(0)}]${fmtBox(b.bbox)} ${b.text}`).join(' | ')
    );
    // Filtered out here, before *any* consumer sees `bubbles` — not just
    // finalizeReading's speech-bound path. probeForContent (autoscroll's
    // lightweight probe) reads this same captureAndRecognize() result
    // directly to decide where to glide next, bypassing finalizeReading
    // entirely; confirmed live that the overlay's own bbox was winning
    // Math.min(...kept.map(b => b.bbox.y0)) there and autoscroll was
    // gliding toward the *overlay itself* as if it were newly-discovered
    // manga text. Filtering this early means every consumer is automatically
    // covered, not just whichever ones remember to call it themselves.
    const withoutOverlay = excludeOverlayBubbles(rawBubbles, width, height, overlayRect);
    // Same idea, inverted: excludeOverlayBubbles drops the one known
    // unwanted region; this keeps only what's *inside* the manga image(s)
    // actually on screen, dropping everything else the screenshot swept up
    // along with it — site header/nav, chapter-selector chrome, "You're
    // reading X at Y.com"-style disclaimers, comments, a synopsis/info
    // page's own description text, etc. User-reported directly: reading a
    // manga's info/synopsis page (not a chapter) was picking up unrelated
    // site text, since that page can still have an image large enough to
    // pass isEligibleImage. Falls back to no-op (keep everything) when no
    // tracked image was actually in view — better to risk reading a little
    // extra chrome than to go silent because image tracking hasn't caught
    // up yet (e.g. right after a page swap, before the observer fires).
    const bubbles = excludeOutsideImages(withoutOverlay, width, height, imageRects);
    const kept = bubbles.filter(
      (b) =>
        b.confidence >= STATE.minConfidence &&
        !MVR_LOGIC.isLikelyGarbage(b.text) &&
        !MVR_LOGIC.isReaderChrome(b.text) &&
        !MVR_LOGIC.isUrlOnly(b.text)
    );
    logEvent(`${kept.length} kept after confidence/garbage filter`);
    // A bubble that reconstructed from multiple merged words (isolated
    // single-token noise is excluded here — that's almost always real
    // screentone/UI-chrome garbage, not a misread) at decent confidence, but
    // still failed the garbage-shape check, is a different signal than "OCR
    // wasn't confident": it means real dialogue most likely got misread
    // badly enough to look like garbage text and got silently dropped —
    // confirmed live ("L-LET ME GO..." OCR'd as "1-1E江 ME GO", 90%
    // confidence, correctly garbage-shaped and correctly dropped, but a real
    // bubble nonetheless). The average-confidence bad-draw check below can't
    // catch this: the rest of the page reading cleanly keeps the average
    // high even though this one bubble vanished.
    const droppedAsGarbage = bubbles.filter(
      (b) =>
        b.confidence >= STATE.minConfidence &&
        MVR_LOGIC.isLikelyGarbage(b.text) &&
        b.text.trim().split(/\s+/).length >= 2
    );
    if (droppedAsGarbage.length) {
      logEvent(
        `${droppedAsGarbage.length} bubble(s) dropped as garbage-shaped despite decent confidence — possible misread, not just noise: ` +
          droppedAsGarbage.map((b) => `[${b.confidence.toFixed(0)}] ${b.text}`).join(' | ')
      );
    }
    if (panelBorders && (panelBorders.horizontalCuts.length || panelBorders.verticalCuts.length)) {
      const fmtCut = (c) => `(${Math.round(c.x0)},${Math.round(c.y0)})-(${Math.round(c.x1)},${Math.round(c.y1)})`;
      logEvent(
        `Panel borders: horizontal [${panelBorders.horizontalCuts.map(fmtCut).join(', ')}], ` +
          `vertical [${panelBorders.verticalCuts.map(fmtCut).join(', ')}]`
      );
    }
    const avgConfidence = kept.length ? kept.reduce((s, b) => s + b.confidence, 0) / kept.length : 0;
    return { width, height, kept, avgConfidence, droppedAsGarbageCount: droppedAsGarbage.length, panelBorders };
  }

  // A bubble cut off by the bottom edge of the screenshot OCRs as a
  // truncated sentence — skip it unless we're at the true bottom of the
  // page (nothing more to scroll to) or the read was forced. Checked via
  // tracked-image geometry rather than window.scrollY/scrollHeight for the
  // same reason as currentPositionSignal() — robust to sites that scroll an
  // inner container instead of the window.
  // The overlay stays visible at all times now (see requestOcrCapture) —
  // it's real on-screen content by the time a capture happens, so
  // chrome.tabs.captureVisibleTab's screenshot genuinely includes it, and
  // without this its own button/status text ("Read", "Autoscroll", status
  // messages) would occasionally get OCR'd and queued as if it were manga
  // dialogue. Excluding by *position* (its own known screen rect) instead
  // of by hiding it keeps it always visible to the user while still
  // stopping its text from ever reaching the recognizer's output. `rect` is
  // measured once, right at the moment the screenshot is requested (see
  // requestOcrCapture) and threaded through here — not re-queried fresh at
  // this point, since the overlay auto-sizes to its own status/button text
  // and can genuinely be a different size by the time OCR finishes
  // (500ms-3s+ later); confirmed live that a freshly-queried rect missed
  // the overlay's actual captured position and let "Pause"/"Stop Scroll"
  // reach speech during autoscroll.
  // CSS-pixel getBoundingClientRect() -> device-pixel canvas coordinates,
  // shared by excludeOverlayBubbles and excludeOutsideImages below.
  function cssRectToCanvasBox(rect, canvasWidth, canvasHeight) {
    const scaleX = canvasWidth / window.innerWidth;
    const scaleY = canvasHeight / window.innerHeight;
    return { x0: rect.left * scaleX, y0: rect.top * scaleY, x1: rect.right * scaleX, y1: rect.bottom * scaleY };
  }
  function boxesOverlap(a, b) {
    return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
  }

  function excludeOverlayBubbles(kept, canvasWidth, canvasHeight, rect) {
    if (!rect || !canvasWidth || !window.innerWidth) return kept;
    if (rect.width <= 0 || rect.height <= 0) return kept;
    const box = cssRectToCanvasBox(rect, canvasWidth, canvasHeight);
    return kept.filter((b) => !boxesOverlap(b.bbox, box));
  }

  // Keeps only bubbles overlapping at least one manga image actually on
  // screen — everything else the screenshot swept up along with it (site
  // header/nav, chapter-selector chrome, disclaimers, comments, a synopsis
  // page's own description text) gets dropped the same way the overlay
  // does. `rects` are measured at the same moment as overlayRect (see
  // requestOcrCapture) for the same staleness reason. No-op (keeps
  // everything) when no tracked image was in view — safer to risk a little
  // extra chrome than to go silent if image tracking hasn't caught up yet.
  function excludeOutsideImages(kept, canvasWidth, canvasHeight, rects) {
    if (!rects || !rects.length || !canvasWidth || !window.innerWidth) return kept;
    const boxes = rects.map((r) => cssRectToCanvasBox(r, canvasWidth, canvasHeight));
    return kept.filter((b) => boxes.some((box) => boxesOverlap(b.bbox, box)));
  }

  function finalizeReading(result, force) {
    // Overlay bubbles are already filtered out of `kept` by
    // captureAndRecognize (see excludeOverlayBubbles) — done there, before
    // this function or autoscroll's probeForContent ever see the result,
    // rather than here, so every consumer of a capture is covered.
    const { width, height, kept, panelBorders } = result;
    const atPageBottom = ![...knownImages].some(
      (img) => isEligibleImage(img) && img.getBoundingClientRect().top > window.innerHeight
    );
    const cutoffMargin = height * 0.02;
    const cutoff = kept.filter((b) => b.bbox.y1 >= height - cutoffMargin);
    // A bubble sliced by the *top* edge (its upper lines already scrolled
    // past) has no bottom-edge counterpart above it in this codebase — the
    // only thing left visible is a fragment PaddleOCR still confidently
    // "reads" as some garbled word (confirmed live: "STELITLEK", a fragment
    // of an already-spoken "STEP BACK A LITTLE" bubble ghosting in at
    // y0=0). Unlike a bottom cutoff there's no useful reposition to offer —
    // scrolling backward mid-read isn't wanted — so this is a pure
    // exclusion, same "don't speak a half-bubble" principle as the bottom
    // case, just without the recovery step.
    const topCutoff = kept.filter((b) => b.bbox.y0 <= cutoffMargin);
    const excluded = force || atPageBottom ? [] : new Set([...cutoff, ...topCutoff]);
    const visible = force || atPageBottom ? kept : kept.filter((b) => !excluded.has(b));
    if (visible.length !== kept.length) {
      logEvent(`${kept.length - visible.length} skipped as cut off at the top/bottom edge`);
    }
    const ordered = MVR_LOGIC.orderBubbles(visible, STATE.direction, panelBorders, width);
    // Canvas/bbox coordinates are viewport-relative (the capture *is* a
    // screenshot of the current viewport) but in *device* pixels — converted
    // to CSS pixels via deviceYToCssY so autoscroll can safely compare/add
    // this to window.innerHeight/scrollY (see that function's comment for
    // why this conversion is necessary, not just defensive).
    const rawTopY = ordered.length ? Math.min(...ordered.map((b) => b.bbox.y0)) : null;
    const topY = rawTopY === null ? null : deviceYToCssY(rawTopY, height);
    // Topmost bubble that got excluded above for being cut off at the bottom
    // edge — not just skipped-and-forgotten, this is what runCaptureOCR uses
    // to reposition (scroll it up near the top) so the *next* capture gets
    // it whole instead of silently waiting for the user to scroll further
    // themselves. Only set when not already forced/at-page-bottom (those
    // paths don't exclude anything to begin with, so cutoff is never
    // populated there — there's nothing to reposition for).
    const rawCutoffTopY = force || atPageBottom || !cutoff.length ? null : Math.min(...cutoff.map((b) => b.bbox.y0));
    const cutoffTopY = rawCutoffTopY === null ? null : deviceYToCssY(rawCutoffTopY, height);
    return {
      texts: ordered.map((b) =>
        MVR_LOGIC.insertMissingWordSpace(
          MVR_LOGIC.fixDigitLetterConfusion(b.text.replace(/\s+/g, ' ').trim(), commonWordsSet),
          commonWordsSet
        )
      ),
      topY,
      cutoffTopY,
    };
  }

  // Capture, OCR, retry once on a bad draw, drop bottom-edge-truncated
  // bubbles, and return final reading order as plain text lines.
  async function recognizeVisiblePanel(force) {
    let result = await captureAndRecognize();
    const LOW_CONFIDENCE = 78; // clean captures average ~90+; garbled ones notably lower
    const looksLowConfidence = result.kept.length && result.avgConfidence < LOW_CONFIDENCE;
    const droppedSuspiciousContent = result.droppedAsGarbageCount > 0;
    if (!force && (looksLowConfidence || droppedSuspiciousContent)) {
      logEvent(
        droppedSuspiciousContent
          ? 'Possible misread content dropped as garbage — recapturing once'
          : `Average confidence ${result.avgConfidence.toFixed(0)} looks like a bad draw — recapturing once`
      );
      const retry = await captureAndRecognize();
      // Fewer bubbles lost to the garbage filter wins first — that's the
      // "never drop content" priority directly, not a proxy for it the way
      // average confidence is; confidence only tie-breaks between two
      // retries that dropped the same amount.
      const retryBetter =
        retry.droppedAsGarbageCount < result.droppedAsGarbageCount ||
        (retry.droppedAsGarbageCount === result.droppedAsGarbageCount && retry.avgConfidence > result.avgConfidence);
      if (retryBetter) {
        logEvent(
          `Retry: ${retry.droppedAsGarbageCount} dropped, avg ${retry.avgConfidence.toFixed(0)} (better) — using it`
        );
        result = retry;
      } else {
        logEvent(
          `Retry: ${retry.droppedAsGarbageCount} dropped, avg ${retry.avgConfidence.toFixed(0)} (not better) — keeping the original`
        );
      }
    }
    let { texts, topY, cutoffTopY } = finalizeReading(result, force);

    // Some sites show a transient reading-progress HUD that fades in right
    // when the user scrolls, then fades back out — and since a capture also
    // fires right as scrolling settles, we can end up screenshotting that
    // overlay sitting on top of the new page, not the page itself, even
    // though the tracked image underneath has genuinely changed (confirmed
    // separately via the position/image-identity log). A real page landing
    // with byte-identical dialogue to whatever was *just* read is otherwise
    // essentially impossible, so treat that specific coincidence as "almost
    // certainly caught a transient overlay" and give it a moment to clear
    // before trying again — this is the opposite check from the dedup gate
    // above (which uses position, not text, precisely because normal OCR
    // noise between captures of the *same* spot is expected and shouldn't
    // trigger anything).
    const joined = texts.join(' | ');
    if (!force && joined && joined === lastReadText) {
      logEvent('Captured text matches the last thing read despite a different image — likely a transient overlay; waiting and recapturing once');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const retryResult = await captureAndRecognize();
      const retry = finalizeReading(retryResult, force);
      if (retry.texts.join(' | ') !== joined) {
        logEvent('Retry after the pause produced different text — using it');
        texts = retry.texts;
        topY = retry.topY;
        cutoffTopY = retry.cutoffTopY;
      } else {
        logEvent('Retry still matches — reading it anyway rather than staying silent');
      }
    }
    lastReadText = texts.join(' | ') || lastReadText;
    return { texts, topY, cutoffTopY };
  }

  // Captures the current viewport and OCRs it, then reads everything found.
  // expectedPosition lets a caller pin down which position this capture is
  // *for* at dispatch time (used by the speculative early-capture path in
  // maybeCapture below, which starts a capture before the position is fully
  // confirmed settled) — defaults to reading the position fresh right now,
  // which is what every pre-existing caller wants.
  async function runCaptureOCR(force, expectedPosition) {
    if (capturing) return;
    capturing = true;
    const capturePosition = expectedPosition !== undefined ? expectedPosition : currentPositionSignal();
    logEvent(`Capturing at position [${capturePosition}] (previously read at [${lastReadPosition}])`);
    setStatus('scanning');
    const captureStartedAt = performance.now();
    try {
      const { texts, topY, cutoffTopY } = await recognizeVisiblePanel(force);
      logEvent(`capture+OCR+order took ${Math.round(performance.now() - captureStartedAt)}ms`);
      // A speculative capture (see maybeCapture) starts before the user has
      // definitely stopped scrolling, specifically to overlap OCR's ~600ms
      // cost with the settle-confirmation wait instead of paying both costs
      // back to back. If it turns out they kept scrolling during that
      // window, the result is for a position already scrolled past —
      // speaking it would be actively wrong, not just stale, so it's
      // discarded here rather than queued. The position stays untouched
      // (lastReadPosition isn't set) so the real final position still gets
      // captured normally on a later tick.
      if (currentPositionSignal() !== capturePosition) {
        logEvent(`discarded — scrolled past [${capturePosition}] during capture, now at [${currentPositionSignal()}]`);
        return;
      }
      // A bubble cut off at the bottom edge was excluded above (see
      // finalizeReading) rather than read half-finished. Autoscroll-only:
      // reusing its own established smooth glide to bring it fully into
      // view, matching the topY check below. Deliberately NOT applied
      // during normal reading — user-reported directly: the page moving on
      // its own while manually scrolling (not autoscrolling) is disorienting
      // and unexpected, since they never asked for any automatic scroll.
      // During normal reading a cut-off bubble just stays skipped, same as
      // before this feature existed — the user's own next scroll reveals it
      // naturally. Bails out without queuing speech, same as the topY case:
      // the settle-triggered capture picks up the real read once the glide
      // lands, when the same (or, if several bubbles were stacked closely
      // enough to all be caught by the margin, several) bubble reads fully.
      if (autoScrolling && cutoffTopY !== null) {
        const delta = Math.round(cutoffTopY - autoScrollRepositionMarginPx());
        logEvent(`Bubble cut off at the bottom edge (y=${Math.round(cutoffTopY)}px, viewport ${window.innerHeight}px) — repositioning ${delta}px to bring it fully into view`);
        autoScrollGlideTargetY = window.scrollY + delta;
        startGliding();
        return;
      }
      // Autoscroll-only: the probe already steers the glide toward roughly
      // the right landing spot (see probeForContent), so this is normally a
      // no-op fallback — but the probe's estimate is lightweight and can be
      // off (a bubble revealed only at the real capture's fuller pass, or
      // content that shifted between the probe and this capture). If the
      // real, authoritative topY is still buried well below the top, correct
      // it the same way: steer the glide smoothly to the right spot rather
      // than a separate jump-scroll — matches the main glide's established
      // pace instead of a different-feeling native scrollTo animation, and
      // never freezes-then-jumps, just keeps moving. Bails out *without*
      // queuing speech or marking this position read — the corrective
      // glide changes the position, so the normal settle-triggered capture
      // picks up the real read at the corrected spot once it lands.
      if (autoScrolling && topY !== null && topY > window.innerHeight * AUTOSCROLL_REPOSITION_THRESHOLD_RATIO) {
        const delta = Math.round(topY - autoScrollRepositionMarginPx());
        logEvent(`Autoscroll: text found at y=${Math.round(topY)}px (viewport ${window.innerHeight}px) — gliding ${delta}px to bring it near the top`);
        autoScrollGlideTargetY = window.scrollY + delta;
        startGliding();
        return;
      }
      logEvent('FINAL READING ORDER: ' + texts.map((t, i) => `${i + 1}. ${t}`).join(' || '));
      texts.forEach((t) => {
        // Queuing per-sentence rather than one utterance per bubble keeps a
        // single-line-item interruption (a stop/pause mid-bubble) from
        // discarding an entire multi-sentence bubble at once.
        splitIntoSentences(t).forEach((sentence, idx) => {
          speechQueue.push({ text: sentence, newBubble: idx === 0 });
        });
        totalSpoken++;
      });
      lastReadPosition = capturePosition;
      // Marks the *final* read position (after any reposition-to-top
      // above) — autoScrollTick uses this as the anchor for "how far must
      // the glide travel before probing resumes."
      if (autoScrolling && texts.length) autoScrollLastContentPosition = window.scrollY;
      if (texts.length) startSpeaking();
    } catch (e) {
      console.error("[Haruki's Manga Voice Reader] capture/OCR failed", e);
      const detail = (e && (e.message || String(e))) || 'unknown error';
      logEvent('ERROR: capture/OCR failed — ' + detail);
      setStatus('error', 'Error: ' + detail.slice(0, 90));
      // Leave the actual error message on screen long enough to read
      // instead of letting the idle check below instantly overwrite it.
      setTimeout(() => {
        if (STATE.status === 'error') setStatus('idle');
      }, 8000);
    } finally {
      capturing = false;
      if (STATE.status !== 'error' && !speaking && !speechQueue.length) setStatus('idle');
    }
  }

  // Triggered on a plain timer (not scroll events). Two separate gates:
  // 1. Settle check — the position signal must be unchanged from the
  //    previous poll tick, so a capture only fires once scrolling has
  //    actually stopped rather than mid-scroll on every tick along the way
  //    (which used to read whatever transitional view happened to be on
  //    screen at each 700ms tick during a long scroll, not just the place
  //    the user landed on).
  // 2. Dedup check — position, not OCR text, is the "have I already read
  //    this spot" signal (see lastReadPosition above); scrolling away and
  //    back re-reads it, which is intentional.
  // Logged once per genuinely new settled position (not every 700ms poll),
  // so the log shows exactly what the trigger is seeing without guesswork —
  // whether it's settling somewhere new at all, and whether it then decides
  // that spot's already been read.
  let lastLoggedPosition = undefined;
  function maybeCapture() {
    const currentPos = currentPositionSignal();
    const now = Date.now();
    const justChanged = currentPos !== lastPollPosition;
    if (justChanged) {
      lastPollPosition = currentPos;
      lastPositionChangeTime = now;
    }
    const stillMs = currentPos === null ? 0 : now - lastPositionChangeTime;
    const settled = currentPos !== null && stillMs >= SETTLE_MS;
    if (settled && currentPos !== lastLoggedPosition) {
      lastLoggedPosition = currentPos;
      const already = positionsMatch(currentPos, lastReadPosition);
      logEvent(`Settled at [${currentPos}]${already ? ' — already read, skipping' : ''}`);
    }
    if (!STATE.enabled || capturing || speaking) return;
    if (currentPos === null) return; // nothing eligible currently visible
    if (positionsMatch(currentPos, lastReadPosition)) return;
    if (settled) {
      runCaptureOCR(false, currentPos);
      return;
    }
    // Speculative early capture: rather than waiting the full SETTLE_MS of
    // confirmed stillness before starting OCR (the single most expensive
    // fixed step — ~550-750ms measured), fire as soon as the position has
    // held for one poll tick (~200ms) and let runCaptureOCR's own
    // expectedPosition check discard the result if it turns out the user
    // kept scrolling. Overlaps OCR with the settle-confirmation window
    // instead of paying both costs back to back. Fires once per distinct
    // still position, not every poll tick.
    if (!justChanged && currentPos !== lastSpeculativeAttemptPosition) {
      lastSpeculativeAttemptPosition = currentPos;
      runCaptureOCR(false, currentPos);
    }
  }

  const pollHandle = setInterval(maybeCapture, 200);

  // ---------------- speech ----------------

  // Comic lettering is virtually always ALL CAPS. Piper's phonemizer doesn't
  // carry Windows/Chrome's old SAPI-style "fully-uppercase word = spell out
  // the initialism" behavior, but normalizing case is still harmless and
  // keeps delivery consistent — lowercases any ALL-CAPS word of length >=2,
  // leaves single-letter tokens untouched so an intentionally letter-spelled
  // word like "S-A-M-P-L-E" (each hyphen-separated piece is already its own
  // single-letter token) still gets spelled. Only the audio needs this —
  // logs/queue/dedup keep the raw OCR case.
  function normalizeCaseForSpeech(text) {
    return text.replace(/[A-Za-z']+/g, (word) => {
      if (word.length <= 1) return word;
      if (word !== word.toUpperCase()) return word;
      return word.toLowerCase();
    });
  }

  // Piper is an English-only phonemizer (this project only ever handles
  // English-language scanlations — see project notes), so CJK characters
  // that slip through OCR shouldn't be sent to it at all: user-reported,
  // they were being read aloud as mangled/mispronounced "Chinese letters"
  // rather than just skipped. offscreen.js already drops raw OCR *words*
  // that are entirely non-Latin, but that's a coarse whole-word decision —
  // a word PaddleOCR merges from adjacent CJK and Latin glyphs (e.g. a
  // credits line like "作画：LEEJAE-1", detected as one box) survives that
  // filter intact since it does contain *some* Latin letters, carrying its
  // CJK prefix straight through to speech. This strips at the character
  // level instead, so mixed content keeps its real (Latin) part and only
  // loses the part that was never speakable to begin with. Replaces with a
  // space rather than deleting outright, so two words that only look
  // adjacent because CJK sat between them ("LEE中JAE") don't get wrongly
  // joined into one ("LEEJAE") once the CJK is gone. Audio-path only, like
  // the other normalizers below — logs/queue/dedup keep the raw OCR text,
  // CJK included, so what was actually detected stays visible for
  // debugging.
  const CJK_CHAR_PATTERN = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;
  function stripCjk(text) {
    return text.replace(CJK_CHAR_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  }

  // Comic "HAHAHAHA"-style laughter reads badly through TTS phonemization —
  // Piper has no special handling for it and tries to pronounce the whole
  // run as one long invented word rather than a string of distinct "ha"
  // syllables, and manga often exaggerates the length (10+ reps) well past
  // anything that reads naturally even when pronounced correctly. Breaking
  // it into hyphen-joined syllables gives the phonemizer a clean per-
  // syllable boundary, and capping the repeat count keeps it from reading
  // absurdly long. Only matches a run built *entirely* from these syllables
  // (word-boundary anchored) — a prefixed exaggeration like "BWAHAHAHA"
  // isn't split (out of scope for now; falls through to normal handling).
  function normalizeLaughter(text) {
    return text.replace(/\b(?:ha|he|ho|ah){2,}\b/gi, (match) => {
      const syllables = match.match(/[a-zA-Z]{2}/g) || [match];
      return syllables.slice(0, 5).join('-');
    });
  }

  // Comic "stutter" notation repeats the first letter of a word before it,
  // separated by hyphens ("P-POISON?", "W-W-What...") — Piper's phonemizer
  // treats a single isolated letter as a spelled-out abbreviation ("P" ->
  // "pee"), the same behavior normalizeCaseForSpeech's own comment relies on
  // for intentional letter-spelling ("S-A-M-P-L-E"). That's exactly wrong
  // for a stutter: it reads as a letter name bolted onto the word, not a
  // stammer. Only matches when every repeated fragment is a single letter
  // that's actually the word's own first letter — a real letter-spelled word
  // never has a real word following it (each of its own segments is a bare
  // single letter too), so this can't collide with that case, and genuine
  // hyphenated words ("well-known") don't match either (their first part is
  // never just one letter that happens to equal the second word's own first
  // letter — "re-read" is the closest near-miss and still doesn't match
  // here since fragments are capped at one letter).
  // Expanding "P-" to "PO-" (progressively longer for repeated stutters, so
  // "P-P-POISON" becomes "PO-POI-POISON") gives the phonemizer an actual
  // cut-off syllable to say instead of a letter name.
  function normalizeStutter(text) {
    return text.replace(/\b((?:[A-Za-z]-){1,3})([A-Za-z]{2,})\b/g, (match, fragments, word) => {
      const letters = fragments.split('-').filter(Boolean);
      if (!letters.every((f) => f.toLowerCase() === word[0].toLowerCase())) return match;
      const parts = letters.map((_, i) => word.slice(0, Math.min(i + 2, word.length)));
      return `${parts.join('-')}-${word}`;
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Synthesis runs in the offscreen document (see offscreen.js for why —
  // dynamic import() inside a service worker isn't allowed, the same
  // restriction that already forced OCR there) and plays back fully there
  // too, so there's no Chrome-speechSynthesis-cutoff-bug equivalent to
  // retry around here: it either completes or it errors — except a genuinely
  // dropped response (observed live: the offscreen document's reply to a
  // cold-start synthesis request never arrived, no error either, leaving
  // this promise pending forever and permanently wedging the whole reading
  // loop behind it, since startSpeaking() awaits each line in sequence). A
  // 20s timeout treats that case the same as any other synthesis failure —
  // logged and skipped — rather than letting one dropped message end the
  // session.
  const TTS_RESPONSE_TIMEOUT_MS = 20000;
  function activeVoiceId() {
    return STATE.ttsEngine === 'kokoro' ? STATE.kokoroVoiceId : STATE.piperVoiceId;
  }
  // Takes already-normalized text (see speakOne, the only caller) — kept as
  // a separate function purely for the message round-trip/timeout plumbing,
  // not because it does any text processing of its own.
  function speakTtsOnce(text) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: `no response from offscreen document within ${TTS_RESPONSE_TIMEOUT_MS}ms` });
      }, TTS_RESPONSE_TIMEOUT_MS);
      chrome.runtime.sendMessage(
        {
          type: 'MVR_TTS_SPEAK',
          text,
          voiceId: activeVoiceId(),
          engine: STATE.ttsEngine,
          volume: STATE.volume,
        },
        (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp);
        }
      );
    });
  }

  // A synthesis/playback failure logs and skips that one line rather than
  // crashing the reading loop — there's no second engine to fall back to
  // anymore, so this is the floor: lose at most the one line that actually
  // failed, not the rest of the queue behind it.
  async function speakOne(item) {
    // stripCjk runs first — the other normalizers below are Latin-letter-
    // pattern regexes and have nothing to do on CJK text anyway, and
    // stripping first means they only ever see what's actually going to be
    // spoken.
    const spoken = normalizeCaseForSpeech(normalizeStutter(normalizeLaughter(stripCjk(item.text))));
    // Requires an actual letter/digit, not just non-empty — a bubble that
    // was entirely CJK plus a stray punctuation mark (e.g. "原作：雨宫." with
    // the name itself misread as a CJK glyph) would otherwise leave a lone
    // "." that's technically non-empty text but nothing worth sending to
    // the TTS engine.
    if (!/[A-Za-z0-9]/.test(spoken)) {
      // Logged distinctly from a normal skip so it's clear *why* nothing
      // played, rather than looking like a silent drop.
      logEvent(`skipping (no speakable text after removing CJK): ${item.text}`);
      return;
    }
    setStatus('speaking', spoken.slice(0, 70));
    logEvent(`speaking: ${item.text}`);
    const resp = await speakTtsOnce(spoken);
    if (!resp || resp.ok === false) {
      logEvent(`ERROR: ${STATE.ttsEngine} TTS failed (${(resp && resp.error) || 'unknown error'}) — skipping this line`);
    } else if (typeof resp.synthMs === 'number') {
      logEvent(
        `  ${STATE.ttsEngine}: session=${resp.sessionMs}ms synth=${resp.synthMs}ms play-start=${resp.playStartMs}ms rms=${resp.rmsBefore}->${resp.rmsAfter}`
      );
    }
  }

  // Speech-engine utterances queue back-to-back with zero gap by default,
  // which is a big part of what makes back-to-back bubbles sound like a
  // list being read off rather than a conversation — a narrator (or a real
  // page turn between speakers) actually pauses at a turn boundary. A new
  // bubble gets a real beat; continuing sentences within the same bubble get
  // a much shorter one, just enough to sound like a breath instead of a
  // dead cut.
  const PAUSE_NEW_BUBBLE_MS = 380;
  const PAUSE_SAME_BUBBLE_MS = 120;

  async function startSpeaking() {
    if (speaking) return;
    speaking = true;
    try {
      let first = true;
      while (speechQueue.length && !stopRequested) {
        const item = speechQueue.shift();
        if (!first) {
          await sleep(item.newBubble ? PAUSE_NEW_BUBBLE_MS : PAUSE_SAME_BUBBLE_MS);
          if (stopRequested) break;
        }
        first = false;
        lastSpokenText = item.text;
        await speakOne(item);
      }
    } finally {
      speaking = false;
      if (!speechQueue.length && !stopRequested) setStatus('idle');
    }
  }

  // Used by the popup's Stop button (MVR_STOP) only — a deliberate, opened-
  // the-popup-for-this action, so it means "done with this site": disables
  // the loop (like MVR_SET_ENABLED false), not just the current utterance
  // (otherwise the next poll tick just starts capturing and reading again),
  // and also clears this site's persisted auto-start flag (see
  // background.js) — "don't resume automatically on the next page load
  // here," not just "pause for this one tab." See pauseReading() below for
  // the overlay's lighter equivalent, which deliberately does NOT clear that
  // flag.
  function stopReading() {
    STATE.enabled = false;
    stopRequested = true;
    stopAutoScroll();
    chrome.runtime.sendMessage({ type: 'MVR_TTS_STOP' });
    chrome.runtime.sendMessage({ type: 'MVR_SET_SITE_ENABLED', origin: location.origin, enabled: false });
    speechQueue.length = 0;
    setStatus('idle', 'Stopped');
  }

  // Used by the overlay's Pause button — a quick in-page control, not a
  // deliberate "turn this site off" decision, so unlike stopReading() it
  // leaves the site's persisted auto-start flag untouched: a page refresh
  // (or navigating to the next chapter) re-triggers background.js's
  // auto-resume and reading picks back up normally, same as if Pause had
  // never been pressed. Otherwise disables the loop exactly like
  // stopReading() does.
  function pauseReading() {
    logEvent('pauseReading() called');
    STATE.enabled = false;
    stopRequested = true;
    stopAutoScroll();
    chrome.runtime.sendMessage({ type: 'MVR_TTS_STOP' });
    speechQueue.length = 0;
    setStatus('idle', 'Paused');
  }

  // Shared by the overlay's Read button and the popup's Read button
  // (MVR_READ_NOW) — forces an immediate capture of whatever's currently
  // visible, undoing stopReading()/pauseReading()'s state first (stopRequested
  // latched true, STATE.enabled false) so this also works as a "resume" after
  // Stop/Pause: without this, a capture still runs but startSpeaking()'s
  // while loop refuses to speak anything (gated on !stopRequested) and never
  // drains the queue, so status gets stuck on "Reading…" forever — looks
  // like it's perpetually loading.
  function readNow() {
    stopRequested = false;
    STATE.enabled = true;
    chrome.runtime.sendMessage({ type: 'MVR_SET_SITE_ENABLED', origin: location.origin, enabled: true });
    // User-requested: highlighting real page text (a synopsis, a comment,
    // anything selectable — not manga art) and pressing Read should read
    // *that* instead of OCRing the visible panel. No OCR involved at all
    // here — this is genuine DOM text, so it goes straight into the same
    // speech queue/TTS path OCR'd text uses, skipping the panel-capture
    // pipeline entirely. Falls through to the normal panel-OCR behavior
    // whenever there's no selection (or it's just a stray caret/whitespace
    // click, not an actual highlight).
    const selectedText = (window.getSelection() || '').toString().trim();
    if (selectedText) {
      logEvent(`Reading selected text (${selectedText.length} chars) instead of OCR'ing the panel`);
      splitIntoSentences(selectedText).forEach((sentence, idx) => {
        speechQueue.push({ text: sentence, newBubble: idx === 0 });
      });
      startSpeaking();
      return;
    }
    runCaptureOCR(true);
  }

  // When set, the glide is steering toward this absolute window.scrollY
  // instead of moving freely forever — used once a probe (or the real
  // capture's own reposition check) has found text that needs to land near
  // the top of the viewport. The glide doesn't stop-then-jump to get there;
  // it keeps moving at the same current-speed pace and simply
  // stops once it arrives, so discovering text never interrupts the motion
  // — see freezeGliding's call site inside autoScrollFrame below.
  let autoScrollGlideTargetY = null;

  // Manual per-frame scroll at a fixed, user-configurable px/sec rate — see
  // the section header above for why this replaced
  // scrollTo(...,{behavior:'smooth'}). Delta-time based (not a fixed
  // px/frame) so it stays correct regardless of actual frame rate. Reads
  // autoScrollSpeed() fresh every frame (rather than capturing it once at
  // glide-start) so a mid-glide settings change from the popup takes effect
  // immediately, not just on the next segment.
  function autoScrollFrame(ts) {
    if (!autoScrolling || !autoScrollGliding) {
      autoScrollRAF = null;
      return;
    }
    if (autoScrollLastFrameTs === null) autoScrollLastFrameTs = ts;
    const dtSeconds = (ts - autoScrollLastFrameTs) / 1000;
    autoScrollLastFrameTs = ts;
    const step = autoScrollSpeed() * dtSeconds;
    if (autoScrollGlideTargetY !== null) {
      const remaining = autoScrollGlideTargetY - window.scrollY;
      // Land exactly on the target instead of overshooting past it — a
      // single frame's step can easily be bigger than what's left once
      // we're close. This is the *only* place motion actually stops after
      // text is found; there's no separate jump/correction scroll anymore.
      if (Math.abs(remaining) <= Math.abs(step) || step === 0) {
        window.scrollTo(0, autoScrollGlideTargetY);
        autoScrollGlideTargetY = null;
        freezeGliding();
        logEvent('Autoscroll: reached reading position — stopping to read');
        return;
      }
      window.scrollBy(0, remaining > 0 ? step : -step);
      autoScrollRAF = requestAnimationFrame(autoScrollFrame);
      return;
    }
    window.scrollBy(0, step);
    autoScrollRAF = requestAnimationFrame(autoScrollFrame);
  }

  function startGliding() {
    if (autoScrollGliding) return;
    autoScrollGliding = true;
    autoScrollLastFrameTs = null;
    autoScrollRAF = requestAnimationFrame(autoScrollFrame);
  }

  // Set whenever the glide freezes (a probe found something) — lets
  // autoScrollTick tell "just froze, give the real settle-triggered
  // pipeline a moment to notice and take over" apart from "genuinely idle,
  // safe to resume gliding," which it can't distinguish from state alone.
  let autoScrollFrozenAt = 0;
  function freezeGliding() {
    autoScrollGliding = false;
    autoScrollFrozenAt = Date.now();
    if (autoScrollRAF) {
      cancelAnimationFrame(autoScrollRAF);
      autoScrollRAF = null;
    }
  }

  // Lightweight "is there anything here worth stopping for" check, run
  // directly against captureAndRecognize() rather than the full
  // recognizeVisiblePanel()/runCaptureOCR() pipeline — this is deliberate:
  // a probe's only job is a yes/no signal while gliding, not committing to
  // an actual read (no retries, no queuing, no touching lastReadText/
  // lastReadPosition — those stay untouched so the real settle-triggered
  // capture that follows a freeze isn't confused by what the probe saw).
  // Reuses the `capturing` flag as its own single-flight guard, which also
  // means the normal settle-triggered pipeline can't fire concurrently with
  // a probe — they share the same lock.
  async function probeForContent() {
    if (capturing) return;
    capturing = true;
    // Captured *before* the async OCR call below, specifically so the
    // reposition target is anchored to wherever the screenshot was actually
    // taken — not wherever the glide has since drifted to. The glide keeps
    // moving the whole time OCR is running (that's the entire point of the
    // v5 redesign not freezing on discovery), so by the time the result
    // comes back, window.scrollY has already advanced past this. Using the
    // *current* scrollY as the target's baseline instead of this one was a
    // real bug: it added the correction delta on top of an already-advanced
    // position, overshooting by however far the glide moved during OCR
    // (speed × OCR duration — confirmed live this could be several hundred
    // px on a slow capture, and gets worse on a larger/higher-res viewport,
    // since a bigger screenshot takes OCR longer to process) — this is what
    // was reported as "puts the new discovered letters far past the screen
    // and cuts off" on a larger screen.
    const scrollYAtCapture = window.scrollY;
    try {
      const result = await captureAndRecognize();
      if (!autoScrolling) return;
      if (result.kept && result.kept.length > 0) {
        // Don't hard-stop the instant text is spotted — that read as an
        // abrupt freeze followed by a separate, jumpy corrective scroll
        // (previously a native scrollTo({behavior:'smooth'}), which caps
        // *duration* not speed — see the section header above for why that
        // was already rejected once for the main glide). Instead, steer the
        // same still-moving glide toward wherever this text needs to land
        // to be near the top (autoScrollRepositionMarginPx() from it), and
        // let autoScrollFrame's own arrival check bring it to a stop —
        // one continuous motion, no jump, no interruption at discovery.
        // If it's already well-positioned, the target is just "here," so
        // the glide stops on the very next frame instead of overshooting.
        // If the glide has already carried us past where this target would
        // land (a large OCR delay on a fast glide), autoScrollFrame's own
        // arrival check handles that too — a small snap back to the exact
        // target, never a runaway overshoot forward.
        const probeTopY = deviceYToCssY(Math.min(...result.kept.map((b) => b.bbox.y0)), result.height);
        const target =
          probeTopY > window.innerHeight * AUTOSCROLL_REPOSITION_THRESHOLD_RATIO
            ? scrollYAtCapture + Math.round(probeTopY - autoScrollRepositionMarginPx())
            : scrollYAtCapture;
        autoScrollGlideTargetY = target;
        logEvent(`Autoscroll: text found at y=${Math.round(probeTopY)}px — gliding to reading position`);
      }
    } catch (e) {
      // Ignore — a failed probe just means we keep gliding and try again
      // on the next one.
    } finally {
      capturing = false;
      autoScrollTimer = setTimeout(autoScrollTick, AUTOSCROLL_POLL_MS);
    }
  }

  // Continuous glide (see autoScrollFrame), periodically checked (not
  // stepped) for content — see the "autoscroll" section header above for
  // the full reasoning. This function's only two jobs each tick: (1)
  // recognize when we've *finished* reading something and should resume
  // gliding after a short pause, and (2) otherwise, keep gliding and
  // throttle how often an actual OCR probe fires.
  function autoScrollTick() {
    if (!autoScrolling) return;
    const busy = capturing || speaking || speechQueue.length > 0;
    if (busy) {
      autoScrollIdleSince = 0;
      autoScrollTimer = setTimeout(autoScrollTick, AUTOSCROLL_POLL_MS);
      return;
    }
    const currentY = window.scrollY;
    // Stay clear of re-probing until we've actually put AUTOSCROLL_MIN_
    // ADVANCE_PX between us and the last real read — previously
    // autoScrollLastContentPosition was nulled out as soon as the grace
    // pause elapsed and gliding resumed, which threw away this gate right
    // when it mattered most: the probe throttle (AUTOSCROLL_PROBE_INTERVAL_
    // MS) has almost always already elapsed by the time a multi-second
    // capture+OCR+speak cycle finishes, so the very next tick fired a probe
    // after the glide had only moved a few px — re-finding and re-reading
    // the same still-mostly-in-view text. Confirmed live: this caused the
    // same translator-credit block to be read 5+ times in a row while
    // barely scrolling. Keeping the position set (only ever overwritten by
    // the next real read, in runCaptureOCR) makes the gate hold across the
    // grace-pause-then-resume transition instead of being discarded by it.
    const withinLastReadZone =
      autoScrollLastContentPosition !== null && Math.abs(currentY - autoScrollLastContentPosition) < autoScrollMinAdvancePx();
    if (withinLastReadZone) {
      if (!autoScrollIdleSince) autoScrollIdleSince = Date.now();
      if (Date.now() - autoScrollIdleSince >= AUTOSCROLL_CONTENT_GRACE_MS) {
        if (!autoScrollGliding && Date.now() - autoScrollFrozenAt > AUTOSCROLL_RESUME_GRACE_MS) startGliding();
      }
      autoScrollTimer = setTimeout(autoScrollTick, AUTOSCROLL_POLL_MS);
      return;
    }
    autoScrollIdleSince = 0;
    // While frozen — whether from a probe's freeze or a reposition-to-top
    // scroll — never probe again until gliding has actually resumed. A
    // probe here serves no purpose (we already know this spot has content,
    // that's why we're frozen) and is actively dangerous: re-finding the
    // same static, unmoved view calls freezeGliding() again, which resets
    // the resume-grace timer, which can repeat forever — confirmed live,
    // this stalled autoscroll dead at one scroll position for 100+ seconds,
    // starving out the real settle-triggered capture that was supposed to
    // read it. Only the grace-timeout path below is allowed to move things
    // forward while frozen; the real pipeline (via the busy check above)
    // still preempts it the moment it actually starts capturing.
    if (!autoScrollGliding) {
      if (Date.now() - autoScrollFrozenAt > AUTOSCROLL_RESUME_GRACE_MS) startGliding();
      autoScrollTimer = setTimeout(autoScrollTick, AUTOSCROLL_POLL_MS);
      return;
    }
    // Also skip probing while already steering toward a discovered target —
    // re-probing mid-approach would just find the same text again (now
    // closer to the top) and recompute a different target, making the
    // glide's stopping point jitter instead of holding a single, smooth
    // line toward wherever it first decided to land.
    if (autoScrollGlideTargetY !== null || Date.now() - autoScrollLastProbeAt < AUTOSCROLL_PROBE_INTERVAL_MS) {
      autoScrollTimer = setTimeout(autoScrollTick, AUTOSCROLL_POLL_MS);
      return;
    }
    autoScrollLastProbeAt = Date.now();
    probeForContent();
  }

  function startAutoScroll() {
    if (autoScrolling) return;
    autoScrolling = true;
    autoScrollIdleSince = 0;
    autoScrollLastContentPosition = null;
    autoScrollLastProbeAt = 0;
    // Autoscroll without active reading doesn't mean anything — same resume
    // steps as the Read button, so clicking Autoscroll alone is enough to
    // get a paused/never-started session moving.
    stopRequested = false;
    STATE.enabled = true;
    chrome.runtime.sendMessage({ type: 'MVR_SET_SITE_ENABLED', origin: location.origin, enabled: true });
    logEvent('Autoscroll started');
    const btn = document.getElementById('mvr-autoscroll-btn');
    if (btn) {
      btn.textContent = 'Stop Scroll';
      btn.classList.add('mvr-active');
    }
    startGliding();
    autoScrollTick();
  }

  function stopAutoScroll() {
    if (!autoScrolling) return;
    autoScrolling = false;
    clearTimeout(autoScrollTimer);
    autoScrollTimer = null;
    freezeGliding();
    logEvent('Autoscroll stopped');
    const btn = document.getElementById('mvr-autoscroll-btn');
    if (btn) {
      btn.textContent = 'Autoscroll';
      btn.classList.remove('mvr-active');
    }
  }

  // ---------------- messaging ----------------

  function onMessage(msg, sender, sendResponse) {
    switch (msg.type) {
      case 'MVR_INIT':
        Object.assign(STATE, msg.settings || {});
        // Fire-and-forget: gets the TTS session loading immediately instead
        // of waiting for the first captured line to trigger it lazily, so
        // that first line doesn't also eat the session's one-time
        // cold-start cost.
        chrome.runtime.sendMessage({ type: 'MVR_TTS_WARM', voiceId: activeVoiceId(), engine: STATE.ttsEngine });
        sendResponse({ ok: true });
        break;
      case 'MVR_SET_SETTINGS':
        Object.assign(STATE, msg.settings || {});
        sendResponse({ ok: true });
        break;
      case 'MVR_GET_STATE':
        sendResponse({
          enabled: STATE.enabled,
          status: STATE.status,
          processedCount: totalSpoken,
          queueLength: speechQueue.length,
          direction: STATE.direction,
          autoScrollSpeed: STATE.autoScrollSpeed,
          effectiveAutoScrollSpeed: autoScrollSpeed(),
        });
        break;
      case 'MVR_GET_LOG':
        sendResponse({ log: logBuffer });
        break;
      case 'MVR_SET_ENABLED':
        STATE.enabled = !!msg.enabled;
        if (STATE.enabled) {
          stopRequested = false;
          maybeCapture();
        } else {
          chrome.runtime.sendMessage({ type: 'MVR_TTS_STOP' });
          setStatus('idle', 'Paused');
        }
        sendResponse({ ok: true });
        break;
      case 'MVR_STOP':
        stopReading();
        sendResponse({ ok: true });
        break;
      case 'MVR_READ_NOW':
        readNow();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
    return true;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // Debug hook: call from DevTools console (or automation) to inspect what
  // the extension currently sees, without affecting normal operation.
  window.__mvrDebug = function () {
    return {
      stateEnabled: STATE.enabled,
      capturing,
      totalSpoken,
      speechQueueLength: speechQueue.length,
      speaking,
      knownImagesCount: knownImages.size,
      hasVisibleManga: hasVisibleManga(),
      autoScrolling,
      autoScrollGliding,
      autoScrollSpeed: autoScrollSpeed(),
    };
  };

  window.__mvrTeardown = function () {
    chrome.runtime.sendMessage({ type: 'MVR_TTS_STOP' });
    stopRequested = true;
    clearTimeout(autoScrollTimer);
    if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
    clearInterval(pollHandle);
    mo.disconnect();
    chrome.runtime.onMessage.removeListener(onMessage);
    const overlay = document.getElementById('mvr-overlay');
    if (overlay) overlay.remove();
  };

  setStatus('idle', 'Ready');
})();
