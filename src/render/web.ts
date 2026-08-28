import { Marked } from "marked";
import {
  DEFAULT_TOC,
  TOC_MODES,
  decodeEntities,
  slugifyHeading,
  type RenderOpts,
  type Theme,
  type TocMode,
} from "../util.ts";
import { FAVICON_PATH } from "../favicon.ts";
import { WEBFONT_CSS, WEBFONT_FAMILY, WEBFONT_PRELOAD } from "../webfont.ts";
import { MERMAID_INIT_URL, MERMAID_URL } from "../mermaid.ts";
import { ANNOUNCEMENTS } from "../announce.ts";
import {
  flattenFrontmatter,
  frontmatterTitle,
  parseFrontmatter,
  type FmValue,
} from "../frontmatter.ts";

/** The placement names as a literal the inline scripts can test against. */
const TOC_MODE_RE = `/^(?:${TOC_MODES.join("|")})$/`;

/**
 * The dark palette, shared by the forced theme and the OS one. Written out
 * twice they drift, and a token that reaches only one of them paints its text
 * the colour of its own background.
 */
const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #1a1a1a; --fg: #e0e0e0; --muted: #999; --border: #444;
    --code-bg: #2a2a2a; --link: #6cb6ff;
    --scroll-thumb: rgba(255,255,255,.20);
    --scroll-thumb-hover: rgba(255,255,255,.34);
    --hit-bg: #3d3200; --hit-fg: #ffe9a3;
    --hit-line-bg: #55450a;
    --hit-cur-bg: #b98900; --hit-cur-fg: #1a1a1a;
  `;

export interface TreeNode {
  name: string;
  path: string; // path relative to base dir; "" for root
  dir: boolean;
  children: TreeNode[];
}

/**
 * A value as a JS literal for an inline `<script>`. `<` is escaped because a
 * `</script>` anywhere in the data would otherwise end the block early.
 */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** HTML-escape text node content. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the filetree (directory mode) as a collapsible, resizable sidebar nav,
 * plus its toggle button and drag-to-resize handle.
 * Folders carry `data-path` so their open/closed state can be persisted.
 */
function renderSidebar(tree: TreeNode, currentRel: string): string {
  const renderNodes = (nodes: TreeNode[]): string => {
    if (!nodes.length) return "";
    let html = "<ul>";
    for (const n of nodes) {
      if (n.dir) {
        // Folder with at least one .md descendant → render, open by default.
        const inner = renderNodes(n.children);
        html += `<li><details open data-path="${esc(n.path)}"><summary>${esc(n.name)}/</summary>${inner}</details></li>`;
      } else {
        const active = n.path === currentRel ? ` class="active" aria-current="page"` : "";
        const href = "/" + encodeURI(n.path).replace(/#/g, "%23");
        html += `<li><a href="${href}"${active}>${esc(n.name)}</a></li>`;
      }
    }
    return html + "</ul>";
  };
  const inner = renderNodes(tree.children);
  if (!inner) return "";
  return `<button id="mdrfc-sidebar-toggle" class="mdrfc-iconbtn" type="button" title="Toggle file list (Ctrl-B)" aria-label="Toggle file list" aria-expanded="true" aria-controls="mdrfc-sidebar">&#9776;</button>
<aside id="mdrfc-sidebar" class="mdrfc-sidebar mdrfc-scroll" aria-label="Files"><div class="mdrfc-tree">${inner}</div></aside>
<div id="mdrfc-resizer" class="mdrfc-resizer" role="separator" aria-orientation="vertical" aria-label="Resize file list" title="Drag to resize · double-click to reset"></div>`;
}

interface Heading {
  level: number;
  id: string;
  /** Heading text, still escaped as marked emitted it, inline markup dropped. */
  text: string;
}

/** The body's headings, in document order, as the anchor pass left them. */
function extractHeadings(html: string): Heading[] {
  const out: Heading[] = [];
  const re = /<h([1-6]) id="([^"]*)">([\s\S]*?)<\/h\1>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[3]!.replace(/<[^>]+>/g, "").trim();
    if (text) out.push({ level: Number(m[1]), id: m[2]!, text });
  }
  return out;
}

/** A document with one heading or none has nothing worth listing. */
const MIN_TOC_HEADINGS = 2;

/**
 * Build the table of contents from the body's own headings.
 * Indentation is relative to the shallowest heading present, so a document
 * whose sections all start at h2 isn't listed one step in, and clamped so a
 * deeply nested tail still fits a margin column.
 *
 * The markup ships whatever the placement setting says: hiding it, or moving
 * it to a margin, is the stylesheet's job, so the reader can switch placement
 * without the page being rendered again.
 */
function renderTocHtml(headings: Heading[]): string {
  if (headings.length < MIN_TOC_HEADINGS) return "";
  const base = Math.min(...headings.map((h) => h.level));
  const items = headings
    .map((h) => {
      const depth = Math.min(h.level - base, 3);
      return `<li class="lvl-${depth}"><a href="#${h.id}">${h.text}</a></li>`;
    })
    .join("");
  return (
    `<nav id="mdrfc-toc" class="mdrfc-toc mdrfc-scroll" data-mdrfc-chrome aria-label="Table of contents">` +
    `<div class="mdrfc-toc-head">Contents</div><ol class="mdrfc-toc-list">${items}</ol></nav>`
  );
}

/** Render frontmatter as a definition-list metadata block above the document. */
function renderFrontmatterHtml(data: Record<string, FmValue>): string {
  const pairs = flattenFrontmatter(data);
  if (!pairs.length) return "";
  const rows = pairs
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v).replace(/\n/g, "<br>")}</dd>`)
    .join("");
  return `<dl class="mdrfc-fm">${rows}</dl>`;
}

/**
 * Render markdown → standalone HTML.
 * RFC-style: monospace, 72ch max content width, centered.
 * Frontmatter is stripped from the body, shown as a metadata block (unless
 * disabled) and its `title` becomes the document title. A table of contents
 * follows it, placed at the top of the document or in either margin.
 * Injects a tiny live-reload client (server-sent events) when `reloadToken` is set,
 * and a settings panel (theme / searchable font picker / size / content width /
 * contents placement) persisted in localStorage.
 * `tree` (directory mode) adds a fixed sidebar listing every .md file.
 */
export function renderWeb(
  md: string,
  opts: RenderOpts & { dirMode?: boolean; source?: string },
  reloadToken?: string,
  tree?: TreeNode | null,
  currentRel?: string
): string {
  const marked = new Marked();
  // ```mermaid becomes a diagram container rather than a code block; every
  // other fence keeps marked's own output, syntax class and all.
  marked.use({
    renderer: {
      code(token) {
        const lang = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
        return lang === "mermaid" ? mermaidBlock(token.text) : false;
      },
    },
  });
  const fm = parseFrontmatter(md);
  const body = addCodeBlockTools(
    addHeadingAnchors(marked.parse(fm.content) as string)
  );
  const meta = opts.frontmatter ? renderFrontmatterHtml(fm.data) : "";
  const toc = renderTocHtml(extractHeadings(body));
  const theme = opts.theme;
  const sidebar = tree ? renderSidebar(tree, currentRel ?? "") : "";
  return htmlTemplate(
    meta + toc + openExternalLinksInNewTab(body),
    opts.width,
    theme,
    reloadToken,
    sidebar,
    documentTitle(fm.data, body, currentRel || opts.source),
    opts.dirMode === true,
    opts.toc ?? DEFAULT_TOC,
    body.includes("mdrfc-mermaid")
  );
}

/**
 * Name the browser tab after the document: a frontmatter `title`, else the
 * first heading, else the filename. Only a nameless document read off stdin
 * falls through to the bare tool name.
 */
function documentTitle(
  fmData: Record<string, FmValue>,
  body: string,
  path?: string
): string | undefined {
  return frontmatterTitle(fmData) ?? firstHeadingText(body) ?? fileTitle(path);
}

/** The first <h1>'s text, with markup dropped and marked's escapes undone. */
function firstHeadingText(html: string): string | undefined {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
  if (!m) return undefined;
  const text = decodeEntities(m[1].replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** A path's filename, minus its markdown extension. */
function fileTitle(path?: string): string | undefined {
  if (!path) return undefined;
  const name = (path.split(/[\\/]/).pop() ?? "").replace(/\.mdx?$/i, "").trim();
  return name || undefined;
}

/**
 * Give every <h1>..<h6> an `id="<slug>"`, so anchor links (`#section`)
 * actually scroll, and a permalink handle that links to it. marked core
 * emits neither.
 * Slug: lowercase, trim, collapse spaces/punct to hyphens, dedupe.
 *
 * The handle holds no text of its own — its `#` is drawn by CSS — so the
 * document's text stays exactly what the markdown said. Both the page title
 * and the search highlighter read that text.
 */
function addHeadingAnchors(html: string): string {
  const seen = new Map<string, number>();
  const uniqueSlug = (slug: string): string => {
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n === 0 ? slug : `${slug}-${n}`;
  };
  return html.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, inner: string) => {
      const id = uniqueSlug(slugifyHeading(inner));
      const handle =
        `<a class="mdrfc-anchor" href="#${id}" aria-label="Link to this section"` +
        ` title="Copy link to this section"></a>`;
      return `<h${level} id="${id}">${inner}${handle}</h${level}>`;
    }
  );
}

/**
 * Wrap every code block in a positioned container carrying a top-right toolbar:
 * a line-wrap toggle and a copy button. The toolbar sits outside the <pre> so
 * it stays put while the block scrolls horizontally; clicks are handled by a
 * delegated listener, which also covers blocks that arrive via in-place nav.
 */
function addCodeBlockTools(html: string): string {
  return html.replace(
    /<pre(\s[^>]*)?>([\s\S]*?)<\/pre>/g,
    (m, attrs: string | undefined, inner: string) =>
      // A diagram brings its own container and its own toolbar.
      (attrs ?? "").includes(MERMAID_MARK)
        ? m
        : `<div class="mdrfc-code"><div class="mdrfc-code-tools" data-mdrfc-chrome>` +
          codeBtn("wrap", "Toggle line wrapping", ' aria-pressed="false"') +
          codeBtn("copy", "Copy code") +
          `</div><pre${attrs ?? ""}>${inner}</pre></div>`
  );
}

/** A button for a code block's or diagram's top-right toolbar. */
function codeBtn(act: string, label: string, extra = ""): string {
  return (
    `<button type="button" class="mdrfc-code-btn" data-act="${act}"` +
    ` title="${label}" aria-label="${label}"${extra}>${act}</button>`
  );
}

/** Marks the source `<pre>` of a diagram, so the code block tools skip it. */
const MERMAID_MARK = "data-mdrfc-mermaid";

/**
 * A ```mermaid fence, as its source plus an empty slot for the drawing.
 *
 * Sending the source and letting the browser replace it is what makes every
 * way this can fall short read as plain markdown: no bundle on disk, no
 * JavaScript, a diagram with a syntax error. The `source` button swaps back to
 * it once a drawing has taken its place.
 */
function mermaidBlock(source: string): string {
  return (
    `<div class="mdrfc-code mdrfc-mermaid">` +
    `<div class="mdrfc-code-tools" data-mdrfc-chrome>` +
    codeBtn("open", "Open the diagram full screen") +
    codeBtn("source", "Show the diagram source", ' aria-pressed="false"') +
    codeBtn("copy", "Copy diagram source") +
    `</div>` +
    `<pre ${MERMAID_MARK}><code class="language-mermaid">${esc(source)}</code></pre>` +
    `<div class="mdrfc-mermaid-out" data-mdrfc-chrome></div>` +
    `</div>`
  );
}

/**
 * Add `target="_blank" rel="noopener noreferrer"` to external links so they
 * open in a new tab instead of navigating the viewer away (VSCode-style UX).
 * Only affects http(s) and protocol-relative URLs; anchors and relative
 * links are left untouched.
 */
function openExternalLinksInNewTab(html: string): string {
  return html.replace(
    new RegExp('<a href="((?:https?:)?//[^"]*)"', "g"),
    '<a href="$1" target="_blank" rel="noopener noreferrer"'
  );
}

function htmlTemplate(
  body: string,
  width: number,
  theme: Theme,
  reloadToken?: string,
  sidebar = "",
  docTitle?: string,
  dirMode = false,
  tocMode: TocMode = DEFAULT_TOC,
  hasMermaid = false
): string {
  // Live reload. The stream is told which document this tab is showing, so an
  // edit somewhere else in the tree doesn't pull it out from under the reader;
  // in-place navigation moves the subscription with it.
  const reloadScript = reloadToken
    ? `<script>
(function(){
  var es = null, path = "", lost = false;
  function connect(){
    if(es) es.close();
    path = location.pathname;
    es = new EventSource("/_reload?path=" + encodeURIComponent(path));
    es.onmessage = function(e){ if(e.data === "reload") location.reload(); };
    // A stream that comes back after the server went away is a server started
    // again, serving a document that may have moved on while it was gone.
    es.onopen = function(){ if(lost) location.reload(); };
    es.onerror = function(){ lost = true; };
  }
  function follow(){ if(location.pathname !== path) connect(); }
  window.addEventListener("mdrfc:navigated", follow);
  window.addEventListener("popstate", follow);
  connect();
})();
</script>`
    : "";

  const htmlThemeAttr =
    theme === "light" || theme === "dark" ? ` data-theme="${theme}"` : "";

  // Runs before first paint so the content column never reflows, and the
  // sidebar never flashes at the wrong width or slides in from collapsed on
  // every navigation.
  const sidebarBoot = sidebar
    ? `
    var w = localStorage.getItem("mdrfc.sidebarW");
    if(w) root.style.setProperty("--sidebar-w", parseInt(w,10)+"px");
    var collapsed = localStorage.getItem("mdrfc.sidebarCollapsed") === "1";
    // narrow screens start collapsed regardless of the desktop preference
    if(window.matchMedia("(max-width: 720px)").matches) collapsed = true;
    if(collapsed) root.classList.add("mdrfc-sidebar-collapsed");`
    : "";
  // The margin needs a window wide enough to hold a column beside the text.
  // Measuring that needs a laid-out document, so this coarse test stands in
  // until the placement script can measure — a fallback settled after the
  // first paint would otherwise shove the document down as it landed. It is
  // the placement actually in force that gets tested, stored or served: a
  // served margin on a narrow window paints in the wrong place otherwise.
  const bootScript = `<script>
(function(){
  try {
    var root = document.documentElement;
    // First, before anything that can throw: the margin placement is only
    // reachable with scripts running, and the stylesheet hides the column
    // until it has been placed. Without this the list would be in the markup
    // and nowhere on the page.
    root.classList.add("mdrfc-js");
    var cw = parseInt(localStorage.getItem("mdrfc.width"), 10);
    if(cw) root.style.setProperty("--content-w", cw+"ch");
    var stored = localStorage.getItem("mdrfc.toc");
    var toc = ${TOC_MODE_RE}.test(stored) ? stored : ${JSON.stringify(tocMode)};
    if((toc === "left" || toc === "right") && !window.matchMedia("(min-width: 1100px)").matches) toc = "top";
    root.setAttribute("data-toc", toc);${sidebarBoot}
  } catch(e){}
})();
</script>`;

  // Where each document was left, keyed by path. Reading half of something
  // long and coming back to it — through a live reload, the sidebar, the back
  // button, or a server started again days later — used to start over at the
  // top. Sits alongside the sidebar's own remembered scroll.
  // In directory mode the module always loads, because in-place navigation can
  // bring a diagram to a page that started without one. Elsewhere it is only
  // asked for by a document that has one — and it is what fetches the 3.5 MB
  // bundle, so a document without a diagram pays for neither.
  const mermaidScript =
    hasMermaid || dirMode
      ? `\n<script type="module" src="${MERMAID_INIT_URL}"></script>`
      : "";

  const scrollScript = `<script>
(function(){
  var KEY = "mdrfc.scroll:";
  var HANDOFF = "mdrfc.pendingHit";  // the palette's, read by the highlighter
  var MAX = 200;                     // documents kept; least recently read drop
  function path(url){ return new URL(url || location.href, location.href).pathname; }
  function rd(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function wr(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
  // The handoff is one navigation wide and belongs to the tab that made it.
  function handoff(){ try{ return sessionStorage.getItem(HANDOFF); }catch(e){ return null; } }

  var lastSet = -1, want = -1;

  // Stamped, so the pruning below has something to rank entries by.
  function save(url){
    wr(KEY + path(url), JSON.stringify({ y: Math.round(window.scrollY), t: Date.now() }));
  }

  function stored(url){
    var raw = rd(KEY + path(url));
    if(!raw) return null;
    try{ return JSON.parse(raw); }catch(e){ return null; }
  }

  // The browser clamps to the height it has, which before the images land is
  // short of where the reader was. Hold on to what was asked for, and take the
  // landing — not the ask — as the mark that tells the reader's own scrolling
  // apart from this.
  function go(y){
    want = y;
    window.scrollTo(0, y);
    lastSet = Math.round(window.scrollY);
  }

  // A hash and a pending search hit are both destinations the reader just
  // asked for, so neither gives way to where this document was last left.
  // Returns whether the caller's own fallback is still needed.
  function restore(url){
    if(new URL(url || location.href, location.href).hash) return false;
    if(handoff()) return false;
    var hit = stored(url);
    if(!hit || !hit.y) return false;
    go(hit.y);
    return true;
  }
  window.mdrfcScroll = { save: save, restore: restore };

  // An entry now outlives the tab that wrote it and nothing else clears it,
  // so a tree read through over months would grow without end. Trim to the
  // most recently read, once per load rather than on every save.
  function stamp(k){
    try{ return JSON.parse(localStorage.getItem(k)).t || 0; }catch(e){ return 0; }
  }
  function prune(){
    var entries = [];
    try {
      for(var i = 0; i < localStorage.length; i++){
        var k = localStorage.key(i);
        if(k && k.indexOf(KEY) === 0) entries.push({ k: k, t: stamp(k) });
      }
    } catch(e){ return; }
    if(entries.length <= MAX) return;
    entries.sort(function(a, b){ return a.t - b.t; });
    for(var j = 0; j < entries.length - MAX; j++){
      try{ localStorage.removeItem(entries[j].k); }catch(e){}
    }
  }

  // Left to itself the browser restores from a height it measured before the
  // stored font size and column width were applied, landing in the wrong place.
  try { if("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch(e){}

  // A write per frame of a flick scroll is a hundred synchronous trips to
  // storage for one position worth keeping; a quarter second of stillness
  // reads the same to the reader.
  var pending = 0, touched = false;
  window.addEventListener("scroll", function(){
    if(Math.abs(window.scrollY - lastSet) > 2) touched = true;
    if(pending) return;
    pending = setTimeout(function(){ pending = 0; save(); }, 250);
  }, { passive: true });
  // The write the throttle is waiting on never happens if the tab goes first.
  window.addEventListener("pagehide", function(){ save(); });

  restore();
  prune();
  // Images and a webfont land after this runs and move the offset out from
  // under it. Repeat once everything has settled, from the offset asked for
  // rather than the clamped landing — unless the reader has meanwhile scrolled
  // somewhere of their own choosing, or was never restored at all because a
  // hash or a search hit had already claimed where the page opens.
  window.addEventListener("load", function(){ if(!touched && want > 0) go(want); });
})();
</script>`;

  // Table of contents: placement and section tracking. The list itself is in
  // the document already; this decides where it sits and which entry is lit.
  const tocScript = `<script>
(function(){
  var root = document.documentElement;
  var SERV = ${JSON.stringify(tocMode)};
  var MODES = ${TOC_MODE_RE};
  // The column is measured in the reader's own text, not in fixed pixels: a
  // list set in 24px type needs a box to match, or every entry in it loses
  // characters to the ellipsis as the type grows. Ratios against the 14px
  // default, so a page nobody has resized is laid out exactly as before.
  var MIN_EM = 190 / 14;   // narrower than this a margin column reads as a scrap
  // And wider than this it stops being a margin: 240px is ~34 characters of the
  // page's own type against the text's 72, and the width the stylesheet falls
  // back to when nothing has been measured yet.
  var MAX_EM = 240 / 14;
  var GAP_EM = 24 / 14;    // clear space between the column and the document
  var EDGE_EM = 12 / 14;   // and between the column and the window, when pushed out
  var PAD_EM = 16 / 14;    // and between the document and whatever is beside it
  var SPY = 84;      // a heading above this line counts as the section in view

  var mode = SERV, toc = null, links = [], targets = [], offsets = [], current = -1;
  var lastW = -1, lastX = -1;
  // Right edge of the filetree, measured with the column. Nothing the script
  // places — column or layer — may be pulled back over it.
  var blocked = 0;

  function stored(){ try{ return localStorage.getItem("mdrfc.toc"); }catch(e){ return null; } }

  // The text size in force: set on the root by the settings panel when the
  // reader has picked one, left to the stylesheet's default when they have not.
  function size(){
    var v = parseFloat(root.style.getPropertyValue("--font-size"));
    if(!(v > 0)) v = parseFloat(getComputedStyle(root).getPropertyValue("--font-size"));
    return v > 0 ? v : 14;
  }

  /**
   * Put the list where the setting asks for, if it fits. A margin column is
   * measured against the space actually left beside the text — which the
   * window size, the content width, the font size and the filetree all move —
   * and gives way to the top of the document when that space runs out.
   */
  // The whole text of an entry too long for the column, laid over the document
  // at the entry's own coordinates. One element, reused: there is only ever one
  // entry under the pointer.
  var peek = document.createElement("div");
  peek.id = "mdrfc-toc-peek";
  peek.setAttribute("aria-hidden", "true");   // the entry itself is the one read out
  document.body.appendChild(peek);

  // The entry the layer is currently finishing, so a column that scrolls can
  // tell the entry moving out from under the pointer from the browser bringing
  // a tabbed one into view.
  var peekFor = null;

  function hidePeek(){
    peekFor = null;
    if(peek.style.display !== "none") peek.style.display = "none";
  }

  function showPeek(a){
    if(a.scrollWidth <= a.clientWidth + 1){ hidePeek(); return; }  // nothing was cut
    var r = a.getBoundingClientRect();
    var edge = EDGE_EM * size();
    var left = blocked + edge;   // the filetree is not the document's to cover
    peekFor = a;
    peek.textContent = a.textContent;
    peek.classList.toggle("active", a.classList.contains("active"));
    // Only the pointer lights the entry underneath; an entry tabbed to keeps
    // the document's own colours, and the layer has to arrive in the colours
    // of whatever it is finishing.
    peek.classList.toggle("lit", a.matches(":hover"));
    peek.style.maxWidth = Math.round(root.clientWidth - edge - left) + "px";
    peek.style.display = "block";
    peek.style.top = Math.round(r.top) + "px";
    // Sits where the entry sits, and is pulled back in when its tail would
    // otherwise run off the window — over the document rather than past it.
    var x = Math.min(r.left, root.clientWidth - edge - peek.offsetWidth);
    peek.style.left = Math.round(Math.max(left, x)) + "px";
  }

  function entry(e){
    return e.target && e.target.closest ? e.target.closest("#mdrfc-toc a") : null;
  }

  function onPoint(e){
    var a = entry(e);
    if(a) showPeek(a); else hidePeek();
  }

  // Below this the filetree lies over the document rather than beside it, so
  // it takes nothing out of the room the page has to lay anything out in.
  function overlaid(){
    return !!window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  }

  // The page box the placement hands the document: where its left edge sits,
  // and what is left over on its right. The box is set to the document's own
  // width, so the text lands on the edge given rather than somewhere inside a
  // wider box — where the text sits is the placement's to say, not the box's.
  function reserve(left, right){
    root.style.setProperty("--pad-left", Math.round(left) + "px");
    root.style.setProperty("--pad-right", Math.round(right) + "px");
  }

  // Hand the box back to the stylesheet, which is the only state the document's
  // own width can be read in: measured inside a box the placement set, it can
  // only report the width the placement last gave it.
  function unreserve(){
    root.style.removeProperty("--pad-left");
    root.style.removeProperty("--pad-right");
  }

  // Remembered so the observer can tell a layout the placement caused from one
  // the reader did — reserving the column moves the document by design.
  function settled(main){
    var r = main.getBoundingClientRect();
    lastW = r.width;
    lastX = r.left;
    return r;
  }

  function place(){
    hidePeek();
    root.classList.remove("mdrfc-toc-placed");
    unreserve();
    var main = document.querySelector("main");
    // Mid-swap there is no document to measure against. No box is handed out
    // until there is one again, and the observer is told to trust nothing it
    // remembers from the last placement.
    if(!main){ lastW = -1; lastX = -1; return; }
    var em = size();
    var MIN_W = MIN_EM * em, MAX_W = MAX_EM * em;
    var GAP = GAP_EM * em, EDGE = EDGE_EM * em, PAD = PAD_EM * em;
    var vw = root.clientWidth;
    var aside = document.getElementById("mdrfc-sidebar");
    // The width the tree is set to, not the box it currently occupies: it
    // slides in on a transform, and this runs in the frame the slide starts.
    // A rect read there reports the tree half absent and hands the column
    // room that is about to be taken back.
    blocked = aside && !root.classList.contains("mdrfc-sidebar-collapsed") && !overlaid()
      ? parseFloat(getComputedStyle(root).getPropertyValue("--sidebar-w")) || 0 : 0;
    // Where the text belongs before anything is asked of the margins: the
    // middle of the window, whatever the filetree happens to be doing. Held
    // there rather than centred in the room the tree leaves, so that opening
    // the tree, closing it, or moving the list from one margin to the other
    // moves only itself and never the text. A window too narrow to hold the
    // document in the middle of itself pushes it off centre, as far as it has
    // to and no further.
    var c = main.getBoundingClientRect().width;
    var lo = blocked + PAD, hi = Math.max(lo, vw - PAD - c);
    var x = Math.min(Math.max((vw - c) / 2, lo), hi);
    if(!toc || mode === "off" || mode === "top"){
      reserve(x, Math.max(0, vw - x - c));
      root.setAttribute("data-toc", mode);
      settled(main);
      return;
    }
    // The margin the list is asked to stand in, as it already is. When that
    // holds the column, the list moves into room which was empty anyway and
    // nothing else moves at all.
    var free = (mode === "left" ? x - blocked : vw - x - c) - EDGE;
    var w = Math.min(MAX_W, free - GAP);
    if(free < MIN_W + GAP){
      // Not on that side alone. Then both margins pay for the column, not just
      // the one it stands in: it is given the whole of what is spare, less the
      // gap, and the text is pushed off centre by however much that takes.
      var span = vw - blocked - c - 2 * EDGE;
      if(span < MIN_W + GAP){
        reserve(x, Math.max(0, vw - x - c));
        root.setAttribute("data-toc", "top");
        settled(main);
        return;
      }
      w = Math.min(MAX_W, span - GAP);
      x = mode === "left" ? blocked + EDGE + w + GAP : vw - EDGE - w - GAP - c;
    }
    reserve(x, Math.max(0, vw - x - c));
    settled(main);
    root.style.setProperty("--toc-w", Math.round(w) + "px");
    root.style.setProperty("--toc-x",
      Math.round(mode === "left" ? x - GAP - w : x + c + GAP) + "px");
    root.setAttribute("data-toc", mode);
    root.classList.add("mdrfc-toc-placed");
  }

  function index(){
    toc = document.getElementById("mdrfc-toc");
    links = []; targets = []; current = -1;
    if(!toc) return;
    // A document swapped in brings a new list element, so this is attached
    // here rather than once. Scrolling the column moves the entry out from
    // under whatever is laid over it — unless the keyboard put it there, in
    // which case the scroll is the browser bringing the entry into view and
    // the layer goes with it. Tabbing to an entry below the fold scrolls the
    // column as part of focusing it, so this fires on every one of them.
    toc.addEventListener("scroll", function(){
      if(peekFor && peekFor === document.activeElement) showPeek(peekFor);
      else hidePeek();
    }, { passive: true });
    Array.prototype.forEach.call(toc.querySelectorAll("a"), function(a){
      a.classList.remove("active");   // nothing is lit until the spy says so
      var href = a.getAttribute("href") || "";
      var el = href.charAt(0) === "#" ? document.getElementById(decodeURIComponent(href.slice(1))) : null;
      if(el){ links.push(a); targets.push(el); }
    });
  }

  // Keep the lit entry in view when the column scrolls on its own. Done by
  // hand: scrollIntoView would take the document along with it.
  function reveal(a){
    if(!toc || toc.scrollHeight <= toc.clientHeight) return;
    var top = a.offsetTop, bottom = top + a.offsetHeight;
    if(top < toc.scrollTop) toc.scrollTop = top - 8;
    else if(bottom > toc.scrollTop + toc.clientHeight) toc.scrollTop = bottom - toc.clientHeight + 8;
  }

  // Where each heading sits in the document. Read once per layout change
  // rather than per scroll frame: measuring every heading on the way past
  // forces a layout, and a long document is where the list is wanted most.
  function measure(){
    var y = window.scrollY;
    offsets = targets.map(function(el){ return el.getBoundingClientRect().top + y; });
  }

  // The section being read is the last heading to have passed the top of the
  // window; before any has, it is the first.
  function spy(){
    if(!links.length || root.getAttribute("data-toc") === "off") return;
    var line = window.scrollY + SPY;
    var i = 0;
    for(var k = 0; k < offsets.length; k++){
      if(offsets[k] > line) break;
      i = k;
    }
    if(i === current) return;
    if(links[current]) links[current].classList.remove("active");
    current = i;
    links[i].classList.add("active");
    reveal(links[i]);
  }

  function relayout(){
    place();
    measure();
    spy();
  }

  function apply(next){
    mode = MODES.test(next) ? next : SERV;
    relayout();
  }

  // Dragging the font size sends an event per pixel, and each placement forces
  // two synchronous layouts before measuring every heading. One a frame is as
  // often as any of it can be seen.
  var frame = 0;
  function relayoutSoon(){
    if(frame) return;
    frame = requestAnimationFrame(function(){ frame = 0; relayout(); });
  }

  window.mdrfcToc = {
    apply: apply,
    // The text size moves the column without always moving the document —
    // a page whose width the window is already holding down doesn't reflow.
    relayout: relayoutSoon,
    // A document swapped in place brings its own list with it.
    refresh: function(){ index(); relayout(); }
  };

  index();
  apply(stored() || SERV);

  var pending = 0;
  window.addEventListener("scroll", function(){
    if(pending) return;
    pending = requestAnimationFrame(function(){ pending = 0; spy(); });
  }, { passive: true });
  window.addEventListener("resize", relayout);
  // Delegated, so it survives a document swapping the list out under it, and
  // covers the keyboard as well: an entry tabbed to reads in full too.
  document.addEventListener("mouseover", onPoint);
  document.addEventListener("focusin", onPoint);
  // Images landing move every heading below them; without an observer to
  // notice, this is the one moment worth re-measuring for.
  window.addEventListener("load", function(){ measure(); spy(); });
  // The column also moves when the filetree opens or the reader changes the
  // font size or content width. Only width and offset ask for the placement to
  // be worked out again — measuring on every height change would chase the
  // list's own placement — but any height change moves the headings.
  if(window.ResizeObserver){
    var ro = new ResizeObserver(function(){
      var main = document.querySelector("main");
      if(!main) return;
      var r = main.getBoundingClientRect();
      if(r.width !== lastW || r.left !== lastX) place();
      measure();
      spy();
    });
    ro.observe(document.body);
    var el = document.querySelector("main");
    if(el) ro.observe(el);
  }
})();
</script>`;

  // Sidebar behaviour: collapse, drag-resize, and persisted tree state.
  // Navigation swaps <main> in place instead of reloading, so the tree's
  // scroll position and folder open/closed state survive a click.
  const sidebarScript = sidebar
    ? `<script>
(function(){
  var aside = document.getElementById("mdrfc-sidebar");
  var resizer = document.getElementById("mdrfc-resizer");
  var toggle = document.getElementById("mdrfc-sidebar-toggle");
  var main = document.querySelector("main");
  if(!aside || !resizer || !toggle || !main) return;
  var root = document.documentElement;
  var K = "mdrfc.";
  function rd(k, d){ try{ var v = localStorage.getItem(K+k); return v==null?d:v; }catch(e){ return d; } }
  function wr(k, v){ try{ localStorage.setItem(K+k, v); }catch(e){} }
  function isNarrow(){ return window.matchMedia("(max-width: 720px)").matches; }

  // ── collapse ────────────────────────────────────────────────
  function collapsed(){ return root.classList.contains("mdrfc-sidebar-collapsed"); }
  function setCollapsed(v, persist){
    var moved = collapsed() !== v;
    root.classList.toggle("mdrfc-sidebar-collapsed", v);
    toggle.setAttribute("aria-expanded", v ? "false" : "true");
    if(persist) wr("sidebarCollapsed", v ? "1" : "0");
    // The tree is fixed and slides on a transform, so opening or closing it
    // moves nothing the observer watches. The room it takes out of the page is
    // only given back when the placement is worked out again.
    if(moved && window.mdrfcToc) window.mdrfcToc.relayout();
  }
  setCollapsed(collapsed(), false);
  toggle.addEventListener("click", function(){ setCollapsed(!collapsed(), !isNarrow()); });
  document.addEventListener("keydown", function(e){
    if((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "b" || e.key === "B")){
      e.preventDefault();
      setCollapsed(!collapsed(), !isNarrow());
    }
  });

  // ── drag to resize ──────────────────────────────────────────
  var MIN = 160, MAX = 560, DEFAULT_W = 248;
  var width = parseInt(rd("sidebarW", String(DEFAULT_W)), 10) || DEFAULT_W;
  var dragging = false;
  function setWidth(px, persist){
    width = Math.min(MAX, Math.max(MIN, Math.round(px)));
    root.style.setProperty("--sidebar-w", width + "px");
    if(persist) wr("sidebarW", String(width));
    if(window.mdrfcToc) window.mdrfcToc.relayout();
  }
  resizer.addEventListener("pointerdown", function(e){
    if(e.button !== 0) return;
    dragging = true;
    resizer.classList.add("dragging");
    document.body.classList.add("mdrfc-resizing");
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizer.addEventListener("pointermove", function(e){
    if(dragging) setWidth(e.clientX, false);
  });
  function endDrag(){
    if(!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.classList.remove("mdrfc-resizing");
    wr("sidebarW", String(width));
  }
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);
  resizer.addEventListener("dblclick", function(){ setWidth(DEFAULT_W, true); });

  // ── folder open/closed state, keyed by folder path ──────────
  var closed;
  try { closed = new Set(JSON.parse(rd("treeClosed", "[]"))); }
  catch(e){ closed = new Set(); }
  Array.prototype.forEach.call(aside.querySelectorAll("details[data-path]"), function(d){
    d.open = !closed.has(d.getAttribute("data-path"));
  });
  // 'toggle' doesn't bubble, so listen in the capture phase
  aside.addEventListener("toggle", function(e){
    var d = e.target;
    if(!d || d.tagName !== "DETAILS") return;
    var p = d.getAttribute("data-path");
    if(!p) return;
    if(d.open) closed.delete(p); else closed.add(p);
    wr("treeClosed", JSON.stringify(Array.from(closed)));
  }, true);

  // ── scroll position (survives a hard reload too) ────────────
  var SCROLL = K + "treeScroll";
  try {
    var saved = sessionStorage.getItem(SCROLL);
    if(saved) aside.scrollTop = parseInt(saved, 10) || 0;
  } catch(e){}
  var pending = 0;
  aside.addEventListener("scroll", function(){
    if(pending) return;
    pending = requestAnimationFrame(function(){
      pending = 0;
      try { sessionStorage.setItem(SCROLL, String(aside.scrollTop)); } catch(e){}
    });
  }, { passive: true });

  // ── in-place navigation ─────────────────────────────────────
  function swap(html, url){
    var doc = new DOMParser().parseFromString(html, "text/html");
    var next = doc.querySelector("main");
    if(!next){ location.href = url; return; }
    // Painted hits hold ranges into the markup about to be thrown away, which
    // would keep every document ever swapped out alive behind them.
    if(window.mdrfcHighlights) window.mdrfcHighlights.clear();
    main.innerHTML = next.innerHTML;
    if(doc.title) document.title = doc.title;
    var path = new URL(url, location.href).pathname;
    Array.prototype.forEach.call(aside.querySelectorAll("a"), function(a){
      var on = a.pathname === path;
      a.classList.toggle("active", on);
      if(on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    var hash = new URL(url, location.href).hash;
    var target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if(target) target.scrollIntoView();
    else if(!window.mdrfcScroll.restore(url)) window.scrollTo(0, 0);
    if(window.mdrfcToc) window.mdrfcToc.refresh();
    // The live-reload stream subscribes per document; tell it we moved.
    window.dispatchEvent(new CustomEvent("mdrfc:navigated"));
  }
  // Exposed so the command palette can reuse in-place navigation. Resolves
  // once the new document is in the DOM, which is when the palette paints its
  // search hits over it.
  window.mdrfcNavigate = function(url){
    window.mdrfcScroll.save();   // before the address changes under the key
    return fetch(url).then(function(r){ return r.text(); }).then(function(html){
      history.pushState({ mdrfc: 1 }, "", url);
      swap(html, url);
      if(isNarrow()) setCollapsed(true, false);
    }).catch(function(){ location.href = url; });
  };
  aside.addEventListener("click", function(e){
    var a = e.target.closest && e.target.closest("a");
    if(!a || !aside.contains(a)) return;
    if(e.defaultPrevented || e.button !== 0) return;
    if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if(a.target && a.target !== "_self") return;
    if(a.origin !== location.origin) return;
    e.preventDefault();
    window.mdrfcNavigate(a.href);
  });
  window.addEventListener("popstate", function(){
    fetch(location.href)
      .then(function(r){ return r.text(); })
      .then(function(html){ swap(html, location.href); })
      .catch(function(){ location.reload(); });
  });
})();
</script>`
    : "";

  return `<!doctype html>
<html lang="en"${htmlThemeAttr} data-toc="${tocMode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="${FAVICON_PATH}">
<script>
(function(){
  // Preloading the regular face only pays on a page that paints in it. A
  // reader with a font of their own renders none of it, so they are not made
  // to fetch 180 KB they will not use — which the browser would warn about
  // besides. Storage is read here rather than waited for: the face has to be
  // asked for before the first paint or the preload is pointless.
  try {
    var saved = localStorage.getItem("mdrfc.font");
    if(saved && saved !== ${JSON.stringify(WEBFONT_FAMILY)}) return;
  } catch(e){}
  var l = document.createElement("link");
  l.rel = "preload"; l.as = "font"; l.type = "font/woff2";
  l.href = ${JSON.stringify(WEBFONT_PRELOAD)};
  l.crossOrigin = "anonymous";
  document.head.appendChild(l);
})();
</script>
<title>${docTitle ? esc(docTitle) : "mdrfc"}</title>
<style>
${WEBFONT_CSS}
  :root {
    --font-size: 14px;
    --content-w: ${width}ch;
    --sidebar-w: 248px;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #666666;
    --border: #d0d0d0;
    --code-bg: #f4f4f4;
    --link: #2563eb;
    --scroll-thumb: rgba(0,0,0,.22);
    --scroll-thumb-hover: rgba(0,0,0,.38);
    --hit-bg: #fff4b8;
    --hit-fg: #1a1a1a;
    --hit-line-bg: #ffe9a3;
    --hit-cur-bg: #ffc107;
    --hit-cur-fg: #1a1a1a;
  }
  html[data-theme="light"] { color-scheme: light; }
  html[data-theme="dark"] { ${DARK_TOKENS} }
  /* auto: follow OS, unless user forced light */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) { ${DARK_TOKENS} }
  }

  /* ── search hits, painted after a palette jump (Custom Highlight API) ──
     The picked row is banded whole, its query terms brighter inside it; the
     same terms elsewhere in the document stay faint. */
  ::highlight(mdrfc-hit-line) { background-color: var(--hit-line-bg); color: var(--hit-fg); }
  ::highlight(mdrfc-hit) { background-color: var(--hit-bg); color: var(--hit-fg); }
  ::highlight(mdrfc-hit-current) {
    background-color: var(--hit-cur-bg); color: var(--hit-cur-fg);
  }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: "${WEBFONT_FAMILY}", ui-monospace, SFMono-Regular, "SF Mono", Menlo,
                 Consolas, "Liberation Mono", monospace;
    font-size: var(--font-size);
    line-height: 1.6;
    margin: 0;
    /* Horizontal room is the placement script's to hand out: it sets the page
       box to the document's own width and puts its left edge where the text
       belongs — the middle of the window — so the text keeps one place through
       the filetree opening and the contents column moving side to side. The
       fallbacks are what a page with no script running gets. */
    padding: 2rem var(--pad-right, 1rem) 2rem var(--pad-left, 1rem);
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: var(--content-w);
    margin: 0 auto;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.5em; scroll-margin-top: 1rem; }
  h1 { font-size: 1.6em; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1.05em; }
  p { margin: 0.6em 0; }
  a { color: var(--link); }

  /* ── heading permalinks ─────────────────────────────────────── */
  .mdrfc-anchor {
    margin-left: .35em;
    color: var(--muted);
    text-decoration: none;
    opacity: 0;
    transition: opacity .12s;
  }
  .mdrfc-anchor::before { content: "#"; }
  .mdrfc-anchor[data-copied]::before { content: "✓"; }
  h1:hover > .mdrfc-anchor,
  h2:hover > .mdrfc-anchor,
  h3:hover > .mdrfc-anchor,
  h4:hover > .mdrfc-anchor,
  h5:hover > .mdrfc-anchor,
  h6:hover > .mdrfc-anchor,
  .mdrfc-anchor:focus-visible,
  .mdrfc-anchor[data-copied] { opacity: 1; }
  .mdrfc-anchor:hover { color: var(--link); }
  /* No hover to reveal it on touch, so leave it faintly visible. */
  @media (hover: none) { .mdrfc-anchor { opacity: .4; } }

  hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0.8em 0;
    padding: 0.2em 1em;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  code {
    font-family: inherit;
    background: var(--code-bg);
    padding: 0.1em 0.35em;
    border-radius: 3px;
    font-size: 0.92em;
  }
  pre {
    font-family: inherit;
    background: var(--code-bg);
    padding: 1em;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.4;
  }
  pre code { background: none; padding: 0; }

  /* ── code block toolbar (wrap / copy) ───────────────────────── */
  .mdrfc-code { position: relative; }
  .mdrfc-code pre { margin: 1em 0; }
  .mdrfc-code-tools {
    position: absolute; top: 6px; right: 6px;
    display: flex; gap: 4px;
    opacity: 0; transition: opacity .12s;
  }
  .mdrfc-code:hover .mdrfc-code-tools,
  .mdrfc-code-tools:focus-within { opacity: 1; }
  @media (hover: none) { .mdrfc-code-tools { opacity: .65; } }
  .mdrfc-code-btn {
    font-family: inherit; font-size: 11px; line-height: 1;
    padding: 4px 6px; border-radius: 4px;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted);
    cursor: pointer;
  }
  .mdrfc-code-btn:hover { color: var(--fg); }
  .mdrfc-code-btn[aria-pressed="true"] { color: var(--link); border-color: var(--link); }
  .mdrfc-code.wrap pre { white-space: pre-wrap; overflow-wrap: anywhere; }

  /* ── mermaid diagrams ────────────────────────────────────────
     The source is what the server sent, so it is what shows until a drawing
     exists to take its place. The source button swaps back to it. */
  .mdrfc-mermaid .mdrfc-mermaid-out { display: none; }
  .mdrfc-mermaid:not(.rendered) .mdrfc-code-btn[data-act="source"] { display: none; }
  .mdrfc-mermaid.rendered > pre { display: none; }
  .mdrfc-mermaid.rendered .mdrfc-mermaid-out {
    display: block; margin: 1em 0; overflow-x: auto;
  }
  .mdrfc-mermaid.rendered.show-source > pre { display: block; }
  .mdrfc-mermaid.rendered.show-source .mdrfc-mermaid-out { display: none; }
  .mdrfc-mermaid-out svg { max-width: 100%; height: auto; }
  /* The column bounds a diagram in the flow, so a big one opens instead. */
  .mdrfc-mermaid.rendered .mdrfc-mermaid-out { cursor: zoom-in; }
  .mdrfc-mermaid.rendered .mdrfc-mermaid-out:focus-visible {
    outline: 2px solid var(--link); outline-offset: 3px;
  }
  .mdrfc-mermaid:not(.rendered) .mdrfc-code-btn[data-act="open"] { display: none; }

  /* ── the diagram lightbox ────────────────────────────────── */
  #mdrfc-zoom { position: fixed; inset: 0; z-index: 200; display: none; }
  #mdrfc-zoom.open { display: block; }
  #mdrfc-zoom .mdrfc-zoom-stage {
    position: absolute; inset: 0; overflow: hidden; background: var(--bg);
    /* The gestures are the overlay's own; the browser must not also act:
       no scroll or pinch, and no text selected out of the drawing by a pan. */
    touch-action: none; cursor: grab;
    -webkit-user-select: none; user-select: none;
  }
  #mdrfc-zoom .mdrfc-zoom-stage:active { cursor: grabbing; }
  #mdrfc-zoom .mdrfc-zoom-canvas { transform-origin: 0 0; will-change: transform; }
  #mdrfc-zoom .mdrfc-zoom-canvas svg { display: block; width: 100%; height: 100%; }
  #mdrfc-zoom .mdrfc-zoom-tools {
    position: absolute; top: 12px; right: 12px; z-index: 1;
    display: flex; align-items: center; gap: 6px;
    padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); font-size: .8em;
  }
  #mdrfc-zoom .mdrfc-zoom-tools button {
    font: inherit; font-family: inherit; min-width: 2.2em; padding: 1px 6px;
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--code-bg); color: var(--muted); cursor: pointer;
  }
  #mdrfc-zoom .mdrfc-zoom-tools button:hover { color: var(--fg); }
  #mdrfc-zoom .mdrfc-zoom-at {
    min-width: 4em; text-align: center; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .mdrfc-mermaid-err {
    margin: 0 0 1em; font-size: .85em; color: var(--muted);
    border-left: 2px solid var(--border); padding-left: .6em;
  }
  table { border-collapse: collapse; margin: 1em 0; font-size: 0.92em; }
  th, td { border: 1px solid var(--border); padding: 0.4em 0.7em; text-align: left; }
  th { background: var(--code-bg); }
  img { max-width: 100%; }

  /* ── frontmatter metadata block ─────────────────────────────── */
  .mdrfc-fm {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.15em 1em;
    margin: 0 0 1.6em;
    padding: 0 0 1em;
    border-bottom: 1px solid var(--border);
    font-size: 0.92em;
  }
  .mdrfc-fm dt { color: var(--muted); }
  .mdrfc-fm dt::after { content: ":"; }
  .mdrfc-fm dd { margin: 0; overflow-wrap: anywhere; }

  /* ── table of contents ──────────────────────────────────────── */
  .mdrfc-toc { font-size: 0.92em; }
  html[data-toc="off"] .mdrfc-toc { display: none; }
  /* .85em of the list's own .92em: 11px at the 14px default, and it grows with
     the entries below it rather than sitting under them at a fixed size */
  .mdrfc-toc-head {
    color: var(--muted); font-size: .85em; text-transform: uppercase;
    letter-spacing: .06em; margin-bottom: .5em;
  }
  .mdrfc-toc-list { list-style: none; margin: 0; padding: 0; }
  .mdrfc-toc-list li { margin: .1em 0; }
  .mdrfc-toc-list .lvl-1 { padding-left: 1.3em; }
  .mdrfc-toc-list .lvl-2 { padding-left: 2.6em; }
  .mdrfc-toc-list .lvl-3 { padding-left: 3.9em; }
  /* Quieter than the document beside it: the column is there to be glanced
     at, and entries at full strength read as text competing with the text. */
  .mdrfc-toc a {
    display: block; padding: 1px 4px; border-radius: 3px;
    color: var(--muted); text-decoration: none;
  }
  .mdrfc-toc a:hover { background: var(--code-bg); color: var(--link); }
  .mdrfc-toc a.active { color: var(--link); font-weight: 600; }

  /* top: a block of its own, between the metadata and the document. Also what
     a page with no scripts running gets, whatever placement was served: the
     margin is measured and revealed by a script, so without one the list has
     to stay where the document can carry it. */
  html[data-toc="top"] .mdrfc-toc,
  html:not(.mdrfc-js) .mdrfc-toc {
    margin: 0 0 1.6em; padding: 0 0 1em;
    border-bottom: 1px solid var(--border);
  }

  /* margin: out of the flow, beside the column, at coordinates the placement
     script measures. Held invisible until it has, so it is never painted at
     the fallback position first. */
  html.mdrfc-js[data-toc="left"] .mdrfc-toc,
  html.mdrfc-js[data-toc="right"] .mdrfc-toc {
    position: fixed; top: 56px; left: var(--toc-x, 12px);
    width: var(--toc-w, 240px);
    max-height: calc(100vh - 76px);
    overflow-y: auto; overscroll-behavior: contain;
    visibility: hidden;
  }
  html.mdrfc-toc-placed[data-toc="left"] .mdrfc-toc,
  html.mdrfc-toc-placed[data-toc="right"] .mdrfc-toc { visibility: visible; }
  /* one line per entry out there — the width is the document's to spend */
  html.mdrfc-js[data-toc="left"] .mdrfc-toc a,
  html.mdrfc-js[data-toc="right"] .mdrfc-toc a {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* A clipped entry, read whole on hover or on tabbing to it. The column
     scrolls, so it clips anything reaching past its own edge; the tail is
     shown on a layer over the document instead. Set to match the entry
     underneath it — same size, same padding, same corner, and that entry's
     own colours, which is why the hover colours are a class the script sets
     rather than the default — so the text stays put and only the part that
     was missing arrives. A long entry and a short one look the same under the
     pointer; the layer is not a tooltip about the entry, it is the entry,
     finished. Its width is the script's: the room it has is measured from the
     same edges the column is, in the reader's text rather than in pixels. */
  #mdrfc-toc-peek {
    position: fixed; z-index: 60; display: none;
    padding: 1px 4px; border-radius: 3px;
    font-size: 0.92em; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    color: var(--muted); background: var(--bg);
    box-shadow: 0 0 0 1px var(--border), 0 6px 18px rgba(0,0,0,.18);
    pointer-events: none;   /* the entry underneath keeps the hover and click */
  }
  #mdrfc-toc-peek.lit { color: var(--link); background: var(--code-bg); }
  #mdrfc-toc-peek.active { color: var(--link); font-weight: 600; }

  /* ── filetree sidebar (directory mode) ──────────────────────── */
  .mdrfc-sidebar {
    position: fixed; top: 0; left: 0; bottom: 0;
    width: var(--sidebar-w); overflow-y: auto; overflow-x: hidden;
    background: var(--bg); border-right: 1px solid var(--border);
    padding: 52px 4px 14px 12px; box-sizing: border-box;
    font-size: 13px; line-height: 1.5;
    z-index: 40;
    transition: transform .15s ease;
  }

  /* Slim scrollbars, shared geometry. The document thumb stays visible; the
     app chrome (.mdrfc-scroll) reveals its thumb on hover. Both reserve the
     gutter so nothing reflows. */
  html, .mdrfc-scroll {
    scrollbar-width: thin;
    scrollbar-gutter: stable;
  }
  html { scrollbar-color: var(--scroll-thumb) transparent; }
  .mdrfc-scroll { scrollbar-color: transparent transparent; }
  .mdrfc-scroll:hover, .mdrfc-scroll:focus-within {
    scrollbar-color: var(--scroll-thumb) transparent;
  }
  html::-webkit-scrollbar,
  .mdrfc-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
  html::-webkit-scrollbar-track,
  .mdrfc-scroll::-webkit-scrollbar-track { background: transparent; }
  html::-webkit-scrollbar-thumb,
  .mdrfc-scroll::-webkit-scrollbar-thumb {
    border: 3px solid transparent;
    background-clip: content-box;
    border-radius: 999px;
    transition: background-color .15s;
  }
  html::-webkit-scrollbar-thumb { background-color: var(--scroll-thumb); }
  .mdrfc-scroll::-webkit-scrollbar-thumb { background-color: transparent; }
  .mdrfc-scroll:hover::-webkit-scrollbar-thumb { background-color: var(--scroll-thumb); }
  html::-webkit-scrollbar-thumb:hover,
  .mdrfc-scroll::-webkit-scrollbar-thumb:hover { background-color: var(--scroll-thumb-hover); }
  html::-webkit-scrollbar-corner,
  .mdrfc-scroll::-webkit-scrollbar-corner { background: transparent; }
  /* Only the fallback differs from the page's: what the tree leaves, until the
     placement has measured the room and said where the text goes. */
  body.mdrfc-has-sidebar {
    padding-left: var(--pad-left, calc(var(--sidebar-w) + 1rem));
  }
  html.mdrfc-sidebar-collapsed .mdrfc-sidebar { transform: translateX(-100%); }
  html.mdrfc-sidebar-collapsed body.mdrfc-has-sidebar {
    padding-left: var(--pad-left, 1rem);
  }

  /* drag handle: sits on the sidebar's right edge, hidden when collapsed */
  .mdrfc-resizer {
    position: fixed; top: 0; bottom: 0; left: calc(var(--sidebar-w) - 3px);
    width: 6px; z-index: 45; cursor: col-resize;
    background: transparent; transition: background .12s;
  }
  .mdrfc-resizer:hover, .mdrfc-resizer.dragging { background: var(--link); }
  html.mdrfc-sidebar-collapsed .mdrfc-resizer { display: none; }
  body.mdrfc-resizing { user-select: none; cursor: col-resize; }

  .mdrfc-tree ul { list-style: none; margin: 0; padding: 0; }
  .mdrfc-tree li { margin: 0; }
  .mdrfc-tree summary {
    cursor: pointer; user-select: none;
    color: var(--fg); font-weight: 600; padding: 1px 2px;
    list-style: none;
  }
  .mdrfc-tree summary::-webkit-details-marker { display: none; }
  .mdrfc-tree summary::before {
    content: "▸"; display: inline-block; width: 1em; color: var(--muted);
    transition: transform .1s;
  }
  .mdrfc-tree details[open] > summary::before { transform: rotate(90deg); }
  .mdrfc-tree details > ul { padding-left: 14px; }
  .mdrfc-tree a {
    display: block; color: var(--fg); text-decoration: none;
    padding: 1px 2px; border-radius: 3px;
  }
  .mdrfc-tree a:hover { background: var(--code-bg); }
  .mdrfc-tree a.active { color: var(--link); font-weight: 600; }
  /* narrow screens: sidebar overlays the content instead of reserving space */
  @media (max-width: 720px) {
    .mdrfc-sidebar { width: min(280px, 85vw); box-shadow: 2px 0 14px rgba(0,0,0,.25); }
    body.mdrfc-has-sidebar { padding-left: var(--pad-left, 1rem); }
    .mdrfc-resizer { display: none; }
  }

  /* ── floating icon buttons (sidebar toggle, settings gear) ──── */
  .mdrfc-iconbtn {
    position: fixed; top: 12px; z-index: 50;
    width: 34px; height: 34px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--code-bg); color: var(--fg);
    cursor: pointer; font-size: 16px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    opacity: .55; transition: opacity .15s;
  }
  .mdrfc-iconbtn:hover { opacity: 1; }
  #mdrfc-gear { right: 12px; }
  #mdrfc-sidebar-toggle { left: 12px; }
  #mdrfc-panel {
    position: fixed; top: 0; right: 0; height: 100vh; width: 280px;
    background: var(--bg); border-left: 1px solid var(--border);
    box-shadow: -4px 0 18px rgba(0,0,0,.10);
    transform: translateX(105%); transition: transform .2s ease;
    z-index: 60; padding: 18px 16px; box-sizing: border-box; overflow-y: auto;
    font-size: 13px;
  }
  #mdrfc-panel.open { transform: translateX(0); }
  #mdrfc-panel h2 { margin: 0 0 14px; font-size: 14px; border: 0; padding: 0; }
  #mdrfc-panel .row { margin-bottom: 14px; }
  #mdrfc-panel label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
  #mdrfc-panel select,
  #mdrfc-panel input[type=text],
  #mdrfc-panel input[type=number] {
    width: 100%; box-sizing: border-box; font-family: inherit; font-size: 13px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 5px 6px;
  }
  #mdrfc-panel .font-box { position: relative; }
  /* Overlays the rows below instead of shoving them down the panel. */
  #mdrfc-panel .font-list {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 1;
    margin: 4px 0 0; padding: 4px 0; list-style: none;
    max-height: 210px; overflow-y: auto;
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg);
    box-shadow: 0 6px 18px rgba(0,0,0,.18);
  }
  #mdrfc-panel .font-list:empty { display: none; }
  #mdrfc-panel .font-list li {
    padding: 4px 8px; cursor: pointer; display: flex; gap: 8px;
    align-items: baseline; justify-content: space-between;
  }
  #mdrfc-panel .font-list li.active,
  #mdrfc-panel .font-list li:hover { background: var(--code-bg); }
  #mdrfc-panel .tag {
    color: var(--muted); font-size: 10px; text-transform: uppercase;
    letter-spacing: .04em; flex: none;
  }
  #mdrfc-panel .font-list .sample { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #mdrfc-panel .font-empty { padding: 6px 8px; color: var(--muted); }
  #mdrfc-panel .size-row { display: flex; gap: 8px; align-items: center; }
  #mdrfc-panel input[type=range] { flex: 1; }
  #mdrfc-panel .close {
    position: absolute; top: 8px; right: 10px;
    background: none; border: 0; color: var(--muted); font-size: 20px;
    cursor: pointer; line-height: 1;
  }
  #mdrfc-panel button.act {
    width: 100%; padding: 7px; border: 1px solid var(--border);
    background: var(--code-bg); color: var(--fg); border-radius: 4px;
    cursor: pointer; font-family: inherit; font-size: 13px;
  }

  /* ── announcement notice ────────────────────────────────────────
     A corner the reader is not reading in: opposite the margin contents
     column, and clear of the filetree when both are on the same side. */
  #mdrfc-notice {
    position: fixed; z-index: 55; bottom: 16px; right: 16px;
    width: 300px; max-width: calc(100vw - 32px);
    padding: 12px 14px 12px; box-sizing: border-box;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    box-shadow: 0 8px 26px rgba(0,0,0,.18);
    font-size: 12.5px; line-height: 1.5;
    animation: mdrfc-notice-in .18s ease-out;
  }
  html[data-toc="right"] #mdrfc-notice { right: auto; left: 16px; }
  html[data-toc="right"] body.mdrfc-has-sidebar #mdrfc-notice {
    left: calc(var(--sidebar-w) + 16px);
  }
  /* A collapsed filetree is off-screen, so there is nothing to clear. */
  html[data-toc="right"].mdrfc-sidebar-collapsed body.mdrfc-has-sidebar #mdrfc-notice {
    left: 16px;
  }
  @keyframes mdrfc-notice-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) { #mdrfc-notice { animation: none; } }
  #mdrfc-notice h3 {
    margin: 0 22px .35em 0; font-size: 13px; line-height: 1.3;
    border: 0; padding: 0;
  }
  #mdrfc-notice p { margin: 0 0 10px; color: var(--muted); }
  #mdrfc-notice .notice-btns { display: flex; gap: 8px; }
  #mdrfc-notice button {
    flex: 1; padding: 6px 8px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg); border-radius: 4px;
    cursor: pointer; font-family: inherit; font-size: 12.5px;
  }
  #mdrfc-notice button.yes { background: var(--code-bg); font-weight: 600; }
  #mdrfc-notice button:hover { border-color: var(--link); color: var(--link); }
  #mdrfc-notice .close {
    position: absolute; top: 6px; right: 8px; flex: none;
    width: auto; padding: 0 2px;
    background: none; border: 0; color: var(--muted); font-size: 17px;
    line-height: 1; cursor: pointer;
  }

  /* ── command palette (Ctrl/Cmd-K) ───────────────────────────── */
  .mdrfc-p-backdrop {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,.38);
    display: flex; justify-content: center; align-items: flex-start;
    padding: 10vh 1rem 1rem;
  }
  .mdrfc-p-box {
    width: 100%; max-width: 640px; max-height: 70vh;
    display: flex; flex-direction: column;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0,0,0,.35); overflow: hidden;
  }
  .mdrfc-p-input {
    font-family: inherit; font-size: 15px;
    padding: 13px 15px; border: 0; border-bottom: 1px solid var(--border);
    background: transparent; color: var(--fg); outline: none;
  }
  .mdrfc-p-list { margin: 0; padding: 6px 0; list-style: none; overflow-y: auto; flex: 1; }
  .mdrfc-p-group {
    padding: 7px 15px 3px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted);
  }
  .mdrfc-p-row {
    display: flex; align-items: baseline; gap: 10px;
    padding: 4px 15px; cursor: pointer; font-size: 13px;
  }
  .mdrfc-p-row.active { background: var(--code-bg); }
  .mdrfc-p-row.active .mdrfc-p-main { color: var(--link); }
  .mdrfc-p-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Path header over a file's hits. The directory prefix absorbs the
     truncation so the filename — and the snippet below it — stay whole. */
  .mdrfc-p-file {
    display: flex; align-items: baseline;
    padding: 8px 15px 2px; font-size: 11px; color: var(--muted);
  }
  .mdrfc-p-dir { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mdrfc-p-base { flex-shrink: 0; color: var(--fg); opacity: .8; }
  .mdrfc-p-line {
    flex: 0 0 auto; min-width: 2.5em; text-align: right;
    color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .mdrfc-p-row mark { background: transparent; color: var(--link); font-weight: 700; }
  .mdrfc-p-row.active mark { text-decoration: underline; }
  .mdrfc-p-empty { padding: 14px 15px; color: var(--muted); font-size: 13px; }
  .mdrfc-p-hint {
    display: flex; flex-wrap: wrap; gap: 3px 12px;
    padding: 7px 15px; border-top: 1px solid var(--border);
    color: var(--muted); font-size: 11px;
  }
  .mdrfc-p-hint code {
    background: var(--code-bg); color: var(--fg);
    border-radius: 3px; padding: 0 4px; margin-right: 5px; font-size: 11px;
  }
  .mdrfc-p-hint.active { color: var(--link); }
  .mdrfc-p-hint.error { color: #d33; }
  html[data-theme="dark"] .mdrfc-p-hint.error { color: #ff8080; }
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) .mdrfc-p-hint.error { color: #ff8080; }
  }
  .mdrfc-p-foot {
    display: flex; gap: 14px; padding: 7px 15px;
    border-top: 1px solid var(--border); color: var(--muted); font-size: 11px;
  }
  .mdrfc-p-foot kbd {
    font-family: inherit; border: 1px solid var(--border); border-radius: 3px;
    padding: 0 4px; margin-right: 3px;
  }

  /* ── paper ──────────────────────────────────────────────────────
     There is no margin to put the list in: a fixed column prints on the first
     sheet and on none of the ones after it, and the space reserved for it
     would be blank on every one. The list prints where a document carries it,
     at the top, and the text gets the whole page back — the filetree's column
     with it. The page box is an inline property the placement script sets,
     hence the !important. */
  @media print {
    :root { --pad-left: 1rem !important; --pad-right: 1rem !important; }
    html.mdrfc-js[data-toc="left"] .mdrfc-toc,
    html.mdrfc-js[data-toc="right"] .mdrfc-toc {
      position: static; width: auto; max-height: none; overflow: visible;
      visibility: visible;
      margin: 0 0 1.6em; padding: 0 0 1em;
      border-bottom: 1px solid var(--border);
    }
    html.mdrfc-js[data-toc="left"] .mdrfc-toc a,
    html.mdrfc-js[data-toc="right"] .mdrfc-toc a {
      overflow: visible; text-overflow: clip; white-space: normal;
    }
    #mdrfc-toc-peek { display: none; }
  }
</style>
${bootScript}
</head>
<body${sidebar ? ' class="mdrfc-has-sidebar"' : ""}>
${sidebar}<main>
${body}
</main>

<button id="mdrfc-gear" class="mdrfc-iconbtn" type="button" title="Settings" aria-label="Settings">&#9881;</button>
<div id="mdrfc-panel" class="mdrfc-scroll" role="dialog" aria-label="Settings" aria-hidden="true">
  <button type="button" class="close" id="mdrfc-close" aria-label="Close">&times;</button>
  <h2>Settings</h2>
  <div class="row">
    <label for="mdrfc-theme">Theme</label>
    <select id="mdrfc-theme">
      <option value="auto">Auto (follow OS)</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </div>
  <div class="row font-box">
    <label for="mdrfc-font">Font <span class="tag" id="mdrfc-font-count"></span></label>
    <input id="mdrfc-font" type="text" placeholder="Search installed fonts&hellip;" spellcheck="false"
           autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"
           aria-controls="mdrfc-font-list">
    <ul id="mdrfc-font-list" class="font-list" role="listbox"></ul>
  </div>
  <div class="row">
    <label for="mdrfc-size">Font size <span id="mdrfc-size-val"></span></label>
    <div class="size-row">
      <input id="mdrfc-size" type="range" min="10" max="28" step="1" value="14">
      <input id="mdrfc-size-num" type="number" min="10" max="28" step="1" value="14" style="width:58px">
    </div>
  </div>
  <div class="row">
    <label for="mdrfc-toc-mode" title="A margin falls back to the top of the document when the window is too narrow for it">Table of contents</label>
    <select id="mdrfc-toc-mode">
      <option value="off">Off</option>
      <option value="top">Top of document</option>
      <option value="left">Left margin</option>
      <option value="right">Right margin</option>
    </select>
  </div>
  <div class="row">
    <label for="mdrfc-width">Content width <span id="mdrfc-width-val"></span></label>
    <div class="size-row">
      <input id="mdrfc-width" type="range" min="40" max="200" step="1" value="${width}">
      <input id="mdrfc-width-num" type="number" min="40" max="200" step="1" value="${width}" style="width:58px">
    </div>
  </div>
  <div class="row">
    <button type="button" class="act" id="mdrfc-reset">Reset to defaults</button>
  </div>
</div>
<div id="mdrfc-notice" role="status" aria-live="polite" hidden></div>

${reloadScript}
<script>window.__mdrfc = { dirMode: ${dirMode}, mermaidUrl: ${embed(MERMAID_URL)} };</script>
<script type="module" src="/_palette.js"></script>${mermaidScript}
<script>
(function(){
  var K = "mdrfc.";
  var SERV_THEME = ${JSON.stringify(theme)};
  var SERV_WIDTH = ${width};
  var SERV_TOC = ${JSON.stringify(tocMode)};
  var root = document.documentElement;
  var gear = document.getElementById("mdrfc-gear");
  var panel = document.getElementById("mdrfc-panel");
  var closeBtn = document.getElementById("mdrfc-close");
  var themeSel = document.getElementById("mdrfc-theme");
  var fontInput = document.getElementById("mdrfc-font");
  var fontList = document.getElementById("mdrfc-font-list");
  var fontCount = document.getElementById("mdrfc-font-count");
  var sizeRange = document.getElementById("mdrfc-size");
  var sizeNum = document.getElementById("mdrfc-size-num");
  var sizeVal = document.getElementById("mdrfc-size-val");
  var widthRange = document.getElementById("mdrfc-width");
  var widthNum = document.getElementById("mdrfc-width-num");
  var widthVal = document.getElementById("mdrfc-width-val");
  var tocSel = document.getElementById("mdrfc-toc-mode");
  var resetBtn = document.getElementById("mdrfc-reset");

  function rd(k, d){ try{ var v = localStorage.getItem(K+k); return v==null?d:v; }catch(e){ return d; } }
  function wr(k, v){ try{ localStorage.setItem(K+k, v); }catch(e){} }
  function rm(k){ try{ localStorage.removeItem(K+k); }catch(e){} }

  function setTheme(v){
    if(v==="light"||v==="dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
    themeSel.value = v;
    // Diagrams carry their colours inside the SVG, so they have to be drawn
    // again rather than re-styled.
    window.dispatchEvent(new CustomEvent("mdrfc:theme"));
  }
  function applyFont(f){
    var fam = f ? '"'+f.replace(/"/g,"")+'", "${WEBFONT_FAMILY}", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : "";
    document.body.style.fontFamily = fam;
    // Diagrams carry the face they were drawn in inside the SVG, so a new one
    // reaches them only by drawing them again.
    window.dispatchEvent(new CustomEvent("mdrfc:font"));
    // The column is measured in ch, so a new face resizes it against a page
    // box the placement has already pinned. Same reason as the size slider.
    if(window.mdrfcToc) window.mdrfcToc.relayout();
  }
  function applySize(s){
    if(!s){ root.style.removeProperty("--font-size"); sizeVal.textContent = ""; }
    else { root.style.setProperty("--font-size", s+"px"); sizeVal.textContent = "("+s+"px)"; }
    sizeRange.value = s || 14;
    sizeNum.value = s || 14;
    if(window.mdrfcToc) window.mdrfcToc.relayout();
  }
  // The placement pins the page box to the document's own width, so a wider
  // column has nowhere to grow into until the box is worked out again. Only a
  // narrower one moves on its own, which is why the observer alone is not
  // enough here.
  function applyWidth(w){
    if(!w){ root.style.removeProperty("--content-w"); widthVal.textContent = ""; }
    else { root.style.setProperty("--content-w", w+"ch"); widthVal.textContent = "("+w+" cols)"; }
    if(window.mdrfcToc) window.mdrfcToc.relayout();
  }
  // The server's --width is the default: landing back on it clears the override
  // instead of pinning the column to whatever this run happened to start with.
  function setWidth(w, syncNum){
    w = Math.min(200, Math.max(40, w));
    widthRange.value = w;
    if(syncNum) widthNum.value = w;
    if(w === SERV_WIDTH){ rm("width"); applyWidth(""); }
    else { applyWidth(w); wr("width", String(w)); }
  }

  // init
  var t = rd("theme", SERV_THEME || "auto");
  if(t!=="light"&&t!=="dark") t = "auto";
  setTheme(t);

  var f = rd("font", "");
  fontInput.value = f;
  // The stack in the stylesheet is already the default, so an unset font has
  // nothing to apply, nothing to redraw the diagrams for, and no placement to
  // ask for. A stored one does: it reaches the page after the column was last
  // placed, in the face the column is measured in.
  if(f) applyFont(f);

  var s = rd("size", "");
  if(s) applySize(s); else { sizeRange.value = 14; sizeNum.value = 14; }

  var cw = parseInt(rd("width", ""), 10) || SERV_WIDTH;
  widthRange.value = cw;
  widthNum.value = cw;
  if(cw !== SERV_WIDTH) applyWidth(cw);

  // The placement script has already applied this; the panel only shows it.
  var tm = rd("toc", SERV_TOC);
  tocSel.value = ${TOC_MODE_RE}.test(tm) ? tm : SERV_TOC;

  // events
  themeSel.addEventListener("change", function(){
    setTheme(themeSel.value); wr("theme", themeSel.value);
  });
  // Typing only filters the list. The font changes when a family is chosen —
  // a row clicked, or Enter pressed — so a half-typed query never becomes the
  // page font and never reaches localStorage.
  fontInput.addEventListener("input", function(){ renderFonts(fontInput.value.trim()); });
  fontInput.addEventListener("focus", function(){ renderFonts(fontInput.value.trim()); });
  fontInput.addEventListener("keydown", onFontKey);
  document.addEventListener("click", function(e){
    if(!fontInput.contains(e.target) && !fontList.contains(e.target)) cancelFontSearch();
  });
  function onSize(){
    var v = sizeRange.value;
    sizeNum.value = v;
    if(String(v)==="14"){ rm("size"); applySize(""); }
    else { applySize(v); wr("size", String(v)); }
  }
  sizeRange.addEventListener("input", onSize);
  sizeNum.addEventListener("input", function(){
    var v = sizeNum.value;
    sizeRange.value = v;
    if(v && v!=="14"){ applySize(v); wr("size", String(v)); }
    else { rm("size"); applySize(""); }
  });
  widthRange.addEventListener("input", function(){
    setWidth(parseInt(widthRange.value, 10), true);
  });
  // A partial or out-of-range typed value waits for blur rather than being
  // clamped mid-keystroke.
  widthNum.addEventListener("input", function(){
    var v = parseInt(widthNum.value, 10);
    if(v >= 40 && v <= 200) setWidth(v, false);
  });
  widthNum.addEventListener("change", function(){
    setWidth(parseInt(widthNum.value, 10) || SERV_WIDTH, true);
  });
  tocSel.addEventListener("change", function(){
    var v = tocSel.value;
    if(v === SERV_TOC) rm("toc"); else wr("toc", v);
    if(window.mdrfcToc) window.mdrfcToc.apply(v);
  });
  resetBtn.addEventListener("click", function(){
    rm("theme"); rm("font"); rm("size"); rm("width"); rm("toc");
    location.reload();
  });

  // panel toggle
  function openPanel(){
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    loadFonts();
  }
  function closePanel(){
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }
  gear.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);
  document.addEventListener("keydown", function(e){ if(e.key==="Escape") closePanel(); });

  // ── font picker: search over every installed family, monospace first ──
  var MAX_ROWS = 100;
  var fonts = [];        // [{name, mono}]
  var shown = [];        // currently rendered subset
  var active = -1;
  var fontsLoaded = false;

  function loadFonts(){
    if(fontsLoaded) return; fontsLoaded = true;
    fetch("/_fonts").then(function(r){ return r.json(); }).then(function(list){
      fonts = list || [];
      var mono = 0;
      fonts.forEach(function(f){ if(f.mono) mono++; });
      fontCount.textContent = fonts.length ? "(" + mono + " mono of " + fonts.length + ")" : "";
      showDefaultFont();
      if(document.activeElement === fontInput) renderFonts(fontInput.value.trim());
    }).catch(function(){ /* fonts endpoint unavailable; typing a family still works */ });
  }

  // An empty field falls through to the stylesheet's stack, so name the family
  // it lands on. Read the stack off the body rather than repeating it here —
  // the inline style is only set when a font is chosen, i.e. never when empty.
  var GENERIC = /^(ui-)?(monospace|serif|sans-serif|rounded)$|^(system-ui|cursive|fantasy|emoji|math|fangsong)$/;
  function showDefaultFont(){
    if(fontInput.value || !fonts.length) return;
    var stack = getComputedStyle(document.body).fontFamily.split(",");
    for(var i = 0; i < stack.length; i++){
      var fam = stack[i].trim().replace(/^["']|["']$/g, "");
      if(GENERIC.test(fam)) continue;
      for(var k = 0; k < fonts.length; k++){
        if(fonts[k].name === fam){
          fontInput.placeholder = fam + (fonts[k].bundled ? " (bundled default)" : " (system default)");
          return;
        }
      }
    }
  }

  // Rank: exact > prefix > word start > substring > subsequence. Monospace
  // wins ties — proportional text breaks the RFC column alignment.
  function score(name, q){
    if(!q) return 1;
    var n = name.toLowerCase();
    if(n === q) return 100;
    var at = n.indexOf(q);
    if(at === 0) return 80;
    if(at > 0) return n[at-1] === " " ? 60 : 40;
    var i = 0;
    for(var c = 0; c < n.length && i < q.length; c++) if(n[c] === q[i]) i++;
    return i === q.length ? 20 : 0;
  }

  function renderFonts(query){
    var q = query.toLowerCase();
    shown = fonts
      .map(function(f){ return { f: f, s: score(f.name, q) }; })
      .filter(function(r){ return r.s > 0; })
      .sort(function(a, b){
        return (b.s - a.s) || (b.f.mono - a.f.mono) || a.f.name.localeCompare(b.f.name);
      })
      .map(function(r){ return r.f; });

    var extra = shown.length - MAX_ROWS;
    shown = shown.slice(0, MAX_ROWS);
    fontList.innerHTML = "";
    if(!fonts.length) return;                        // still loading, or endpoint down
    if(!shown.length){
      fontList.appendChild(row("No installed family matches — it is applied as typed.", "", true));
      return;
    }
    shown.forEach(function(f, i){
      var li = row(f.name, f.bundled ? "bundled" : f.mono ? "mono" : "", false);
      li.style.fontFamily = '"' + f.name.replace(/"/g, "") + '", ui-monospace, monospace';
      li.addEventListener("click", function(){ pickFont(f.name); });
      li.addEventListener("mousemove", function(){ setActive(i); });
      fontList.appendChild(li);
    });
    if(extra > 0) fontList.appendChild(row("+" + extra + " more — keep typing", "", true));
    setActive(-1);
    fontInput.setAttribute("aria-expanded", "true");
  }

  function row(text, tag, muted){
    var li = document.createElement("li");
    if(muted){ li.className = "font-empty"; li.textContent = text; return li; }
    li.setAttribute("role", "option");
    var s = document.createElement("span");
    s.className = "sample"; s.textContent = text;
    li.appendChild(s);
    if(tag){
      var t = document.createElement("span");
      t.className = "tag"; t.textContent = tag;
      li.appendChild(t);
    }
    return li;
  }

  function setActive(i){
    active = i;
    var items = fontList.querySelectorAll("li[role=option]");
    for(var k = 0; k < items.length; k++) items[k].classList.toggle("active", k === i);
    if(i >= 0 && items[i]) items[i].scrollIntoView({ block: "nearest" });
  }

  function pickFont(name){
    fontInput.value = name;
    applyFont(name);
    if(name) wr("font", name); else rm("font");
    hideFonts();
  }

  /** Abandon the search: drop the query and show the family in force. */
  function cancelFontSearch(){
    fontInput.value = rd("font", "");
    hideFonts();
  }

  function hideFonts(){
    fontList.innerHTML = "";
    active = -1;
    fontInput.setAttribute("aria-expanded", "false");
  }

  function onFontKey(e){
    var open = shown.length > 0 && fontList.childElementCount > 0;
    if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      if(!open){ renderFonts(fontInput.value.trim()); return; }
      e.preventDefault();
      var next = active + (e.key === "ArrowDown" ? 1 : -1);
      setActive((next + shown.length) % shown.length);
    } else if(e.key === "Enter"){
      e.preventDefault();
      // A highlighted row wins; otherwise commit the text as typed, which is
      // how a family the machine has no record of still gets applied.
      pickFont(open && active >= 0 ? shown[active].name : fontInput.value.trim());
    } else if(e.key === "Escape"){
      e.stopPropagation();               // leave the search, keep the panel open
      cancelFontSearch();
    }
  }

  // ── announcements ──────────────────────────────────────────────────────
  // A saved setting is never overwritten to show off a new default, so what a
  // new default cannot do, a notice asks. One question, once: the answer —
  // either answer — is recorded and that notice is finished. The tests live in
  // ANN_WHEN and the offers in ANN_DO, named from the served list rather than
  // carried in it, so nothing here evaluates text as code.
  var ANN = ${embed(ANNOUNCEMENTS)};
  var ANN_WHEN = {
    "always": function(){ return true; },
    // Their own font, and not the bundled one under another route: picking
    // "${WEBFONT_FAMILY}" from the list saves it like any other family, and
    // offering someone the font they are already reading in — then dropping
    // their choice to give it to them — is worse than saying nothing.
    "font-overridden": function(){
      var f = rd("font", "");
      return !!f && f !== ${JSON.stringify(WEBFONT_FAMILY)};
    }
  };
  var ANN_DO = {
    // Dropping the choice lands on the stylesheet's stack, which the bundled
    // family heads — the same thing an emptied font field does.
    "use-bundled-font": function(){ pickFont(""); }
  };
  var notice = document.getElementById("mdrfc-notice");

  function answered(a){ return !!rd("ann." + a.id, ""); }

  function announce(){
    if(!notice) return;
    for(var i = 0; i < ANN.length; i++){
      var a = ANN[i];
      var when = ANN_WHEN[a.when];
      if(answered(a) || !when || !when()) continue;
      showNotice(a);
      return;
    }
  }

  function showNotice(a){
    notice.textContent = "";
    var h = document.createElement("h3");
    h.textContent = a.title;
    var p = document.createElement("p");
    p.textContent = a.body;
    var btns = document.createElement("div");
    btns.className = "notice-btns";
    btns.appendChild(noticeBtn(a.accept, "yes", function(){ answer(a, true); }));
    btns.appendChild(noticeBtn(a.dismiss, "", function(){ answer(a, false); }));
    var x = noticeBtn("\\u00d7", "close", function(){ answer(a, false); });
    x.setAttribute("aria-label", "Dismiss");
    notice.appendChild(x);
    notice.appendChild(h);
    notice.appendChild(p);
    notice.appendChild(btns);
    notice.hidden = false;
  }

  function noticeBtn(label, cls, onClick){
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if(cls) b.className = cls;
    b.addEventListener("click", onClick);
    return b;
  }

  // Closing it counts as an answer: a notice that came back on the next page
  // would be a nag, and the offer stays in the settings panel either way.
  function answer(a, yes){
    wr("ann." + a.id, yes ? "y" : "n");
    if(yes){
      var run = ANN_DO[a.action];
      if(run) run();
    }
    notice.hidden = true;
    notice.textContent = "";
    announce();  // whatever was queued behind it, if anything ever is
  }

  announce();
})();
</script>
<script>
(function(){
  // Delegated so blocks swapped in by in-place navigation keep working.
  document.addEventListener("click", function(e){
    var anchor = e.target.closest && e.target.closest(".mdrfc-anchor");
    if(anchor){
      // The jump is the browser's own; copying the URL is the part worth
      // having, since the address bar is what people would reach for next.
      write(new URL(anchor.getAttribute("href"), location.href).href)
        .then(function(){ tick(anchor); })
        .catch(function(){});
      return;
    }
    var btn = e.target.closest && e.target.closest(".mdrfc-code-btn");
    if(!btn) return;
    var box = btn.closest(".mdrfc-code");
    if(!box) return;
    if(btn.dataset.act === "wrap"){
      var on = box.classList.toggle("wrap");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      return;
    }
    if(btn.dataset.act === "open"){
      if(window.mdrfcMermaid) window.mdrfcMermaid.zoom(box);
      return;
    }
    if(btn.dataset.act === "source"){
      var shown = box.classList.toggle("show-source");
      btn.setAttribute("aria-pressed", shown ? "true" : "false");
      // Search paints what the reader can see, and the source just changed
      // which of the two that is.
      if(window.mdrfcMermaid) window.mdrfcMermaid.syncSource(box);
      return;
    }
    var code = box.querySelector("pre");
    copy(code ? code.textContent : "", btn);
  });

  function copy(text, btn){
    write(text).then(function(){ flash(btn, "copied"); })
               .catch(function(){ flash(btn, "failed"); });
  }

  // navigator.clipboard is absent on plain-http origins other than localhost,
  // which is exactly how this server gets reached over a LAN.
  function write(text){
    if(navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function(resolve, reject){
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch(err){}
      document.body.removeChild(ta);
      ok ? resolve() : reject();
    });
  }

  // The permalink handle has no text to swap, so the tick rides on an
  // attribute the stylesheet reads.
  function tick(a){
    if(a.dataset.busy) clearTimeout(Number(a.dataset.busy));
    a.dataset.copied = "1";
    a.dataset.busy = String(setTimeout(function(){
      delete a.dataset.copied;
      delete a.dataset.busy;
    }, 1200));
  }

  function flash(btn, msg){
    if(btn.dataset.busy) clearTimeout(Number(btn.dataset.busy));
    btn.textContent = msg;
    btn.dataset.busy = String(setTimeout(function(){
      btn.textContent = "copy";
      delete btn.dataset.busy;
    }, 1200));
  }
})();
</script>
${scrollScript}
${tocScript}
${sidebarScript}
</body>
</html>`;
}
