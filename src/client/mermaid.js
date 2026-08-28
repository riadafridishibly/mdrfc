/**
 * Drawing ```mermaid fences as diagrams.
 *
 * The server sends every fence as its own source, inside a container holding
 * an empty slot for the drawing. That is the whole fallback: with this module
 * blocked, the bundle missing, or the diagram mis-written, the reader still
 * sees exactly what the markdown said. A drawing replaces the source only once
 * it exists, and the `source` button in the block's toolbar swaps back.
 *
 * The 3.5 MB bundle is fetched on first sight of a diagram, not on load, so a
 * document without one costs nothing. In directory mode this module is always
 * present, because in-place navigation can bring a diagram to a page that
 * started without any.
 *
 * A diagram in the flow is bounded by the column it sits in, which for a big
 * one means legible-at-a-glance and no more. Opening it fills the viewport
 * instead, with pan and zoom — see the lightbox at the bottom of this file.
 */

const BOX = ".mdrfc-mermaid";
const OUT = "mdrfc-mermaid-out";
const CHROME = "data-mdrfc-chrome";

let bundle = null; // the load promise, once something has asked for it
let generation = 0; // invalidates a render still in flight when the theme moves
let nextId = 0;

/** window.mermaid, loaded once. Rejects if the bundle cannot be fetched. */
function load() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (bundle) return bundle;
  const url = (window.__mdrfc || {}).mermaidUrl;
  bundle = new Promise((resolve, reject) => {
    if (!url) return reject(new Error("no mermaid bundle url"));
    const script = document.createElement("script");
    script.src = url;
    script.onload = () =>
      window.mermaid ? resolve(window.mermaid) : reject(new Error("mermaid did not load"));
    script.onerror = () => reject(new Error("mermaid bundle unreachable"));
    document.head.appendChild(script);
  });
  // One unreachable fetch must not pin every diagram in the tab to "could not
  // be loaded" until a reload: forget the failure so the next sight retries.
  bundle.catch(() => {
    bundle = null;
  });
  return bundle;
}

/** Which of mermaid's two built-in palettes the page is currently wearing. */
function palette() {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark" || forced === "light") return forced === "dark" ? "dark" : "default";
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "default";
}

/**
 * Draw every diagram on the page that is not already drawn in this palette.
 * Re-entrant: a theme change part way through abandons the older pass rather
 * than letting the two interleave their writes.
 */
export async function render() {
  const boxes = [].slice.call(document.querySelectorAll(BOX));
  if (!boxes.length) return;

  let mermaid;
  try {
    mermaid = await load();
  } catch {
    for (const box of boxes) fail(box, "mermaid could not be loaded");
    return;
  }

  const mine = ++generation;
  const theme = palette();
  mermaid.initialize({
    startOnLoad: false,
    theme,
    // The document's own face, so diagram text reads as part of the page.
    fontFamily: getComputedStyle(document.body).fontFamily,
    // Labels are sanitized and `click` directives cannot reach javascript:,
    // because the markdown being viewed is not necessarily the reader's own.
    securityLevel: "strict",
    // Errors belong under the source we already show, not in a graphic
    // mermaid appends to the body on its own initiative.
    suppressErrorRendering: true,
  });

  for (const box of boxes) {
    if (mine !== generation) return;
    if (box.dataset.mermaidTheme === theme) continue;
    await draw(mermaid, box, theme, mine);
  }
}

async function draw(mermaid, box, theme, mine) {
  const source = box.querySelector("pre");
  const out = box.querySelector("." + OUT);
  if (!source || !out) return;

  let svg, bind;
  try {
    const result = await mermaid.render("mdrfc-mermaid-" + ++nextId, source.textContent);
    svg = result.svg;
    bind = result.bindFunctions;
  } catch (err) {
    fail(box, err && err.message ? err.message : String(err));
    return;
  }
  if (mine !== generation) return;

  out.innerHTML = svg;
  if (bind) bind(out);
  out.setAttribute("role", "button");
  out.setAttribute("tabindex", "0");
  out.setAttribute("aria-label", "Open this diagram full screen");
  box.dataset.mermaidTheme = theme;
  box.classList.add("rendered");
  box.classList.remove("failed");
  // Painted search hits must not land on the source now that it is hidden.
  // Showing it again is what puts it back in reach of the highlighter.
  if (!box.classList.contains("show-source")) source.setAttribute(CHROME, "");
}

/** Leave the source showing and say underneath it what went wrong. */
function fail(box, message) {
  const source = box.querySelector("pre");
  if (source) source.removeAttribute(CHROME);
  box.classList.add("failed");
  box.classList.remove("rendered");
  delete box.dataset.mermaidTheme;
  let note = box.querySelector(".mdrfc-mermaid-err");
  if (!note) {
    note = document.createElement("p");
    note.className = "mdrfc-mermaid-err";
    note.setAttribute(CHROME, "");
    box.appendChild(note);
  }
  note.textContent = message;
}

/**
 * Whether the source of `box` is searchable — the highlighter skips chrome, so
 * the attribute tracks what the reader can actually see. Called by the toolbar.
 */
export function syncSource(box) {
  const source = box.querySelector("pre");
  if (!source) return;
  if (box.classList.contains("rendered") && !box.classList.contains("show-source")) {
    source.setAttribute(CHROME, "");
  } else {
    source.removeAttribute(CHROME);
  }
}

/** Draw every diagram again, whatever palette it already carries. */
export function redraw() {
  for (const box of document.querySelectorAll(BOX)) delete box.dataset.mermaidTheme;
  return render().then(refresh);
}

/**
 * Show the source of every diagram whose fence holds all of `terms`, so a
 * search hit inside one has something visible to land on — the drawing took
 * the place of the text the palette is still listing. True if any was shown.
 */
export function revealSource(terms) {
  if (!terms || !terms.length) return false;
  let shownAny = false;
  for (const box of document.querySelectorAll(BOX)) {
    if (!box.classList.contains("rendered") || box.classList.contains("show-source")) continue;
    const source = box.querySelector("pre");
    if (!source) continue;
    const text = source.textContent.toLowerCase();
    if (!terms.every((t) => text.includes(t))) continue;
    box.classList.add("show-source");
    const btn = box.querySelector('.mdrfc-code-btn[data-act="source"]');
    if (btn) btn.setAttribute("aria-pressed", "true");
    syncSource(box);
    shownAny = true;
  }
  return shownAny;
}

window.mdrfcMermaid = { render, redraw, syncSource, revealSource, zoom: open, close, refresh };

render();
// A palette swap needs the diagrams drawn again; so does a document arriving
// in place, which may carry diagrams this page has never drawn. A drawing the
// lightbox is showing has just been replaced, so it is re-taken from the page.
window.addEventListener("mdrfc:theme", () => {
  render().then(refresh);
});
window.addEventListener("mdrfc:navigated", () => {
  close();
  render();
});
// The face is baked into the drawing at render time, so a new one is a redraw
// too — and one the palette stamp cannot detect, hence dropping it by hand.
window.addEventListener("mdrfc:font", redraw);

// Opening from the drawing itself. Delegated, so it holds for diagrams that
// arrive with a document navigated to in place.
document.addEventListener("click", (event) => {
  const out = event.target.closest && event.target.closest("." + OUT);
  if (out) open(out.closest(BOX));
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const out = event.target.closest && event.target.closest("." + OUT);
  if (!out) return;
  event.preventDefault();
  open(out.closest(BOX));
});
if (window.matchMedia) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (!document.documentElement.hasAttribute("data-theme")) render().then(refresh);
  };
  if (dark.addEventListener) dark.addEventListener("change", onChange);
  else if (dark.addListener) dark.addListener(onChange);
}

// ── the lightbox ──────────────────────────────────────────────────────────
/**
 * A diagram opened over the whole viewport, pannable and zoomable.
 *
 * The drawing shown is a copy of the one in the page, so closing leaves
 * nothing behind and a redraw underneath (a palette swap) can simply be taken
 * again. mermaid namespaces every id inside a diagram with the diagram's own
 * id, so renaming that one prefix in the copy is enough to keep the two from
 * colliding over `url(#marker)` references.
 *
 * Panning and zooming are one transform on a wrapper, never a change to the
 * SVG, so the drawing stays as sharp as the zoom asks for.
 */

const SCALE_MIN = 0.05;
const SCALE_MAX = 40;
const PAN_STEP = 60;

let overlay = null; // built on first open
let stage = null;
let canvas = null;
let readout = null;
let shown = null; // the diagram the overlay is showing
let restore = null; // what had focus before it opened
let natural = { w: 0, h: 0 };
let view = { x: 0, y: 0, scale: 1, fit: 1 };
let pointers = new Map();
let pinch = null; // { gap, x, y } at the last move
let dragged = false;
let onDrawing = false; // whether the press that began this click was on the SVG
let copies = 0;

function build() {
  overlay = document.createElement("div");
  overlay.id = "mdrfc-zoom";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram");
  overlay.setAttribute("data-mdrfc-chrome", "");
  overlay.innerHTML =
    '<div class="mdrfc-zoom-tools">' +
    '<button type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>' +
    '<output class="mdrfc-zoom-at"></output>' +
    '<button type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>' +
    '<button type="button" data-zoom="fit" title="Fit to the window">fit</button>' +
    '<button type="button" data-zoom="close" title="Close (Esc)">close</button>' +
    "</div>" +
    '<div class="mdrfc-zoom-stage"><div class="mdrfc-zoom-canvas"></div></div>';
  stage = overlay.querySelector(".mdrfc-zoom-stage");
  canvas = overlay.querySelector(".mdrfc-zoom-canvas");
  readout = overlay.querySelector(".mdrfc-zoom-at");

  overlay.querySelector(".mdrfc-zoom-tools").addEventListener("click", (event) => {
    const act = event.target.dataset && event.target.dataset.zoom;
    if (act === "close") close();
    else if (act === "fit") fit();
    else if (act === "in") zoomAt(1.3, mid());
    else if (act === "out") zoomAt(1 / 1.3, mid());
  });

  // Clicking past the drawing closes, the way a lightbox is expected to — but
  // not when the click is the end of a drag that happened to land there, and
  // not when it began on the drawing: capturing the pointer retargets the
  // click to the stage, so the press is the only record of what was under it.
  stage.addEventListener("click", () => {
    if (!dragged && !onDrawing) close();
  });

  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("dblclick", (event) => {
    zoomAt(1.8, at(event));
  });
  document.body.appendChild(overlay);
}

/** Show `box`'s drawing full screen. Ignores a diagram that has none yet. */
export function open(box) {
  if (!box || !box.classList.contains("rendered")) return;
  // Built once and kept, but rebuilt if it is no longer in the document —
  // nothing in the page removes it, and this costs a check either way.
  if (!overlay || !overlay.isConnected) build();
  if (!take(box)) return;

  shown = box;
  restore = document.activeElement;
  dragged = false;
  onDrawing = false;
  overlay.classList.add("open");
  // Nothing in the overlay holds focus once a pan has begun — a press on the
  // stage puts it on the body — so the keys have to be watched from the
  // document, ahead of the page's own Escape, which this one supersedes.
  document.addEventListener("keydown", onKey, true);
  // The page behind must not scroll under a diagram being dragged over it.
  document.body.style.overflow = "hidden";
  fit();
  overlay.querySelector('[data-zoom="close"]').focus();
}

export function close() {
  if (!overlay || !shown) return;
  document.removeEventListener("keydown", onKey, true);
  overlay.classList.remove("open");
  canvas.innerHTML = "";
  document.body.style.overflow = "";
  shown = null;
  pointers.clear();
  pinch = null;
  if (restore && restore.focus) restore.focus();
  restore = null;
}

/** Re-take the drawing after the page redrew it, holding the current view. */
export function refresh() {
  if (!shown) return;
  if (!shown.classList.contains("rendered") || !take(shown)) return close();
  apply();
}

/**
 * Copy `box`'s SVG onto the canvas at its own size, ids renamed so the copy
 * and the original cannot fight over the markers they share. False if the
 * diagram is not one this can size — which leaves the page as it was.
 */
function take(box) {
  const svg = box.querySelector("." + OUT + " svg");
  if (!svg) return false;
  const viewBox = (svg.getAttribute("viewBox") || "").split(/[\s,]+/);
  const w = parseFloat(viewBox[2]);
  const h = parseFloat(viewBox[3]);
  if (!(w > 0) || !(h > 0)) return false;

  const id = svg.getAttribute("id");
  const markup = id ? svg.outerHTML.split(id).join("mdrfc-zoomed-" + ++copies) : svg.outerHTML;
  canvas.innerHTML = markup;
  const copy = canvas.firstElementChild;
  // mermaid caps the drawing at the column it was drawn for; here it is the
  // viewport that bounds it, and the transform that decides how much of it.
  copy.removeAttribute("style");
  copy.setAttribute("width", String(w));
  copy.setAttribute("height", String(h));
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  natural = { w, h };
  return true;
}

/** The whole diagram, centred, at the largest scale the stage has room for. */
function fit() {
  const box = stage.getBoundingClientRect();
  const room = 0.94; // a margin, so the edges do not sit against the chrome
  const scale = Math.min((box.width * room) / natural.w, (box.height * room) / natural.h);
  // A stage with no size yet would otherwise scale the drawing to nothing.
  view.fit = scale > 0 && Number.isFinite(scale) ? scale : 1;
  view.scale = view.fit;
  view.x = (box.width - natural.w * view.scale) / 2;
  view.y = (box.height - natural.h * view.scale) / 2;
  apply();
}

function apply() {
  canvas.style.transform =
    "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
  // Relative to fitting the window, which is the size the diagram opened at.
  readout.textContent = Math.round((view.scale / view.fit) * 100) + "%";
}

/** Scale by `factor` about a stage point, so what is under it stays put. */
function zoomAt(factor, point) {
  const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, view.scale * factor));
  const ratio = next / view.scale;
  view.x = point.x - (point.x - view.x) * ratio;
  view.y = point.y - (point.y - view.y) * ratio;
  view.scale = next;
  apply();
}

/** An event's position within the stage. */
function at(event) {
  const box = stage.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
}

/** The middle of the stage, for a zoom that came from a button or a key. */
function mid() {
  const box = stage.getBoundingClientRect();
  return { x: box.width / 2, y: box.height / 2 };
}

function onWheel(event) {
  event.preventDefault();
  // A trackpad pinch arrives as a wheel with ctrl held, and wants to move
  // faster than the same distance of scrolling does.
  const rate = event.ctrlKey ? 0.01 : 0.0015;
  zoomAt(Math.exp(-event.deltaY * rate), at(event));
}

function onDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  pointers.set(event.pointerId, at(event));
  dragged = false;
  onDrawing = !!(event.target.closest && event.target.closest(".mdrfc-zoom-canvas"));
  if (pointers.size === 2) pinch = span();
  // Capturing keeps a drag alive past the edge of the stage. It is the last
  // thing done, and forgiven if it fails, so a browser that refuses it still
  // pans — it just stops at the edge.
  try {
    stage.setPointerCapture(event.pointerId);
  } catch {
    // no capture; the pointer events still arrive while it is over the stage
  }
}

function onMove(event) {
  if (!pointers.has(event.pointerId)) return;
  const was = pointers.get(event.pointerId);
  const now = at(event);
  pointers.set(event.pointerId, now);

  if (pointers.size >= 2) {
    // Two fingers: the gap between them sets the scale, their middle the pan.
    const next = span();
    if (pinch && pinch.gap > 0) {
      zoomAt(next.gap / pinch.gap, { x: pinch.x, y: pinch.y });
      view.x += next.x - pinch.x;
      view.y += next.y - pinch.y;
      apply();
    }
    pinch = next;
    dragged = true;
    return;
  }

  view.x += now.x - was.x;
  view.y += now.y - was.y;
  if (Math.abs(now.x - was.x) > 1 || Math.abs(now.y - was.y) > 1) dragged = true;
  apply();
}

function onUp(event) {
  pointers.delete(event.pointerId);
  pinch = pointers.size === 2 ? span() : null;
}

/** The gap between the two live pointers, and the point between them. */
function span() {
  const [a, b] = [...pointers.values()];
  return {
    gap: Math.hypot(a.x - b.x, a.y - b.y),
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

const PAN_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/**
 * The lightbox is modal, so a key it answers is a key the page behind must not
 * see: Escape closes the diagram rather than the settings panel, and the arrows
 * pan rather than scroll.
 */
function onKey(event) {
  if (!shown) return;
  const key = event.key;
  const pan = PAN_KEYS[key];
  if (key === "Escape") close();
  else if (key === "Tab") {
    // The overlay covers the page, so tabbing must stay inside it.
    const stops = [...overlay.querySelectorAll("button")];
    const here = stops.indexOf(document.activeElement);
    const next = event.shiftKey ? here - 1 : here + 1;
    stops[(next + stops.length) % stops.length].focus();
  } else if (key === "+" || key === "=") zoomAt(1.3, mid());
  else if (key === "-" || key === "_") zoomAt(1 / 1.3, mid());
  else if (key === "0") fit();
  else if (pan) {
    view.x += pan[0] * PAN_STEP;
    view.y += pan[1] * PAN_STEP;
    apply();
  } else return;
  event.preventDefault();
  event.stopPropagation();
}
