/**
 * Painting search matches inside the rendered document.
 *
 * Uses the CSS Custom Highlight API: matches are painted from `Range` objects
 * without touching the DOM, so live-reload, in-place navigation and the code
 * block tools keep working on markup identical to what the server sent. Where
 * the API is missing the palette simply behaves as it did before — the jump
 * still happens, only the colour is absent.
 */

const OTHER = "mdrfc-hit";
const LINE = "mdrfc-hit-line";
const CURRENT = "mdrfc-hit-current";
const MAX_MATCHES = 400;
const HANDOFF = "mdrfc.pendingHit";

const supported =
  typeof CSS !== "undefined" &&
  !!CSS.highlights &&
  typeof Highlight === "function" &&
  typeof Range === "function";

/** Drop every painted match. */
export function clearHighlights() {
  if (!supported) return;
  CSS.highlights.delete(OTHER);
  CSS.highlights.delete(LINE);
  CSS.highlights.delete(CURRENT);
}

/**
 * The terms of a query worth painting. fzf's operators address paths, not
 * prose, so `!foo` (a negation) is dropped and the rest are unwrapped to the
 * literal they carry.
 */
export function contentTerms(query) {
  return (query || "")
    .split(/\s+/)
    .filter((t) => t && t !== "|" && t[0] !== "!")
    .map((t) => t.replace(/^[\^']+/, "").replace(/\$$/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Every text node under `root`, flattened into one string plus an offset index.
 * The table of contents is skipped: it repeats every heading, so painting it
 * would double each hit and let a match land on the list instead of the text.
 */
function textMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && n.parentElement.closest("script, style, .mdrfc-toc")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  const starts = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue) continue;
    nodes.push(n);
    starts.push(text.length);
    text += n.nodeValue;
  }
  return { text, lower: text.toLowerCase(), nodes, starts };
}

/** The text node holding global offset `pos`, and the offset within it. */
function locate(map, pos) {
  let lo = 0;
  let hi = map.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { node: map.nodes[lo], offset: pos - map.starts[lo] };
}

/** A live Range over `[from, to)` of the flattened text; may span nodes. */
function toRange(map, from, to) {
  const a = locate(map, from);
  const b = locate(map, to);
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

/** Every occurrence of every term, in document order, duplicates collapsed. */
function occurrences(map, terms) {
  const spans = [];
  for (const t of terms) {
    for (let at = map.lower.indexOf(t); at !== -1; at = map.lower.indexOf(t, at + t.length)) {
      if (spans.length >= MAX_MATCHES) break;
      spans.push([at, at + t.length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return spans.filter((s, i) => i === 0 || s[0] !== spans[i - 1][0] || s[1] !== spans[i - 1][1]);
}

/**
 * The line `[from, to)` sits on, trimmed of surrounding whitespace.
 * marked keeps the source's own newlines inside a block and separates blocks
 * with one, so a newline in the flattened text is exactly a line break of the
 * document — the same unit the palette lists a hit as.
 */
function lineAround(map, from, to) {
  let start = map.text.lastIndexOf("\n", from - 1) + 1;
  let end = map.text.indexOf("\n", to);
  if (end === -1) end = map.text.length;
  while (start < end && /\s/.test(map.text[start])) start++;
  while (end > start && /\s/.test(map.text[end - 1])) end--;
  return [start, end];
}

const collapse = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A palette snippet reduced to what the rendered document actually shows:
 * list/quote/heading markers and inline markup never make it into the DOM,
 * and a long line reaches the palette elided at one or both ends.
 */
function snippetCore(snippet) {
  const bare = snippet
    .replace(/^…/, "")
    .replace(/…$/, "")
    .replace(/^(?:\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s+)+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2");
  return collapse(bare);
}

/** Offset at which the anchored heading's own text begins; -1 if it is gone. */
function anchorOffset(map, anchor) {
  const el = anchor && document.getElementById(anchor);
  if (!el) return -1;
  for (let i = 0; i < map.nodes.length; i++) {
    if (el.contains(map.nodes[i])) return map.starts[i];
  }
  return -1;
}

const NO_MATCH = 4;

/**
 * Which match the palette row pointed at: the one whose line reads as the row.
 * Every hit carries its heading — its own, for a heading hit — so a line before
 * that heading is a coincidence, outranked by anything within the section; an
 * elided or markup-heavy row only matches loosely, which likewise gives way to
 * a line that reads exactly as listed.
 */
function pickCurrent(map, spans, opts) {
  const from = Math.max(0, anchorOffset(map, opts.anchor));
  const want = opts.snippet ? snippetCore(opts.snippet) : "";

  if (want.length >= 4) {
    const rank = (span) => {
      const line = collapse(map.text.slice(...lineAround(map, span[0], span[1])));
      const fit = line === want ? 0 : line.includes(want) || want.includes(line) ? 1 : NO_MATCH;
      return fit + (span[0] >= from ? 0 : 2);
    };
    let best = -1;
    let bestRank = NO_MATCH;
    for (let i = 0; i < spans.length; i++) {
      const r = rank(spans[i]);
      if (r < bestRank) {
        best = i;
        bestRank = r;
      }
    }
    if (best !== -1) return best;
  }

  const after = spans.findIndex((s) => s[0] >= from);
  return after === -1 ? 0 : after;
}

/** Put a range a third of the way down the viewport, where the eye already is. */
function scrollToRange(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.height && !rect.width) return;
  const top = window.scrollY + rect.top - Math.max(72, window.innerHeight * 0.3);
  window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
}

function paint(name, ranges, priority) {
  if (!ranges.length) return;
  const hl = new Highlight(...ranges);
  hl.priority = priority;
  CSS.highlights.set(name, hl);
}

/**
 * Paint the row the palette jumped to — the whole line, as it was listed —
 * with the query brighter inside it, mark the query's other occurrences more
 * faintly, and bring the row into view. `opts.anchor` is the hit's heading
 * slug and `opts.snippet` its line as the palette showed it, both optional.
 * Returns false when nothing was painted.
 */
export function highlightMatches(query, opts = {}) {
  clearHighlights();
  const root = document.querySelector("main");
  const terms = contentTerms(query);
  if (!supported || !root) return false;

  const map = textMap(root);
  if (!map.nodes.length) return false;
  const spans = terms.length ? occurrences(map, terms) : [];

  // A hit whose text the rendering changed beyond recognition still has its
  // heading, so the row is banded even when no term survives to be painted.
  const anchored = spans.length ? -1 : anchorOffset(map, opts.anchor);
  const row = spans.length
    ? lineAround(map, ...spans[pickCurrent(map, spans, opts)])
    : anchored === -1
      ? null
      : lineAround(map, anchored, anchored);
  if (!row || row[0] >= row[1]) return false;

  const onRow = (s) => s[0] >= row[0] && s[1] <= row[1];
  const rowRange = toRange(map, row[0], row[1]);
  paint(LINE, [rowRange], 0);
  paint(OTHER, spans.filter((s) => !onRow(s)).map((s) => toRange(map, s[0], s[1])), 1);
  paint(CURRENT, spans.filter(onRow).map((s) => toRange(map, s[0], s[1])), 2);
  scrollToRange(rowRange);
  return true;
}

/**
 * Hand a pending highlight to the next page. Only needed when the palette
 * cannot navigate in place and the whole document is reloaded.
 */
export function rememberHighlight(state) {
  try {
    sessionStorage.setItem(HANDOFF, JSON.stringify(state));
  } catch {
    /* private mode, or storage full: the jump still works, unpainted */
  }
}

/** Apply — once — a highlight handed over by the page that navigated here. */
export function resumeHighlight() {
  let state = null;
  try {
    const raw = sessionStorage.getItem(HANDOFF);
    sessionStorage.removeItem(HANDOFF);
    if (raw) state = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!state || state.path !== location.pathname) return false;
  return highlightMatches(state.query, state);
}
