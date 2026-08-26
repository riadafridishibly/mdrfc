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
 */

const BOX = ".mdrfc-mermaid";
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
  const out = box.querySelector(".mdrfc-mermaid-out");
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

window.mdrfcMermaid = { render, syncSource };

render();
// A palette swap needs the diagrams drawn again; so does a document arriving
// in place, which may carry diagrams this page has never drawn.
window.addEventListener("mdrfc:theme", () => {
  render();
});
window.addEventListener("mdrfc:navigated", () => {
  render();
});
if (window.matchMedia) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (!document.documentElement.hasAttribute("data-theme")) render();
  };
  if (dark.addEventListener) dark.addEventListener("change", onChange);
  else if (dark.addListener) dark.addListener(onChange);
}
