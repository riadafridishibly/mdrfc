import { Marked } from "marked";
import { slugifyHeading, type RenderOpts, type Theme } from "../util.ts";
import {
  flattenFrontmatter,
  frontmatterTitle,
  parseFrontmatter,
  type FmValue,
} from "../frontmatter.ts";

export interface TreeNode {
  name: string;
  path: string; // path relative to base dir; "" for root
  dir: boolean;
  children: TreeNode[];
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
 * disabled) and its `title` becomes the document title.
 * Injects a tiny WebSocket client for live-reload when `reloadToken` is set,
 * and a settings panel (theme / searchable font picker / size / content width)
 * persisted in localStorage.
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
  const fm = parseFrontmatter(md);
  const body = addCodeBlockTools(
    addHeadingAnchors(marked.parse(fm.content) as string)
  );
  const meta = opts.frontmatter ? renderFrontmatterHtml(fm.data) : "";
  const theme = opts.theme;
  const sidebar = tree ? renderSidebar(tree, currentRel ?? "") : "";
  return htmlTemplate(
    meta + openExternalLinksInNewTab(body),
    opts.width,
    theme,
    reloadToken,
    sidebar,
    documentTitle(fm.data, body, currentRel || opts.source),
    opts.dirMode === true
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
  const text = m[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&") // last: an escaped ampersand must not re-decode
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
  const btn = (act: string, label: string, extra = "") =>
    `<button type="button" class="mdrfc-code-btn" data-act="${act}" title="${label}" aria-label="${label}"${extra}>${act}</button>`;
  return html.replace(
    /<pre(\s[^>]*)?>([\s\S]*?)<\/pre>/g,
    (_m, attrs: string | undefined, inner: string) =>
      `<div class="mdrfc-code"><div class="mdrfc-code-tools">` +
      btn("wrap", "Toggle line wrapping", ' aria-pressed="false"') +
      btn("copy", "Copy code") +
      `</div><pre${attrs ?? ""}>${inner}</pre></div>`
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
  dirMode = false
): string {
  const reloadScript = reloadToken
    ? `<script>
(function(){
  var ws = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/_reload');
  ws.onmessage = function(e){ if(e.data==='reload') location.reload(); };
  ws.onclose = function(){ setTimeout(function(){ location.reload(); }, 1500); };
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
  const bootScript = `<script>
(function(){
  try {
    var root = document.documentElement;
    var cw = parseInt(localStorage.getItem("mdrfc.width"), 10);
    if(cw) root.style.setProperty("--content-w", cw+"ch");${sidebarBoot}
  } catch(e){}
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
    root.classList.toggle("mdrfc-sidebar-collapsed", v);
    toggle.setAttribute("aria-expanded", v ? "false" : "true");
    if(persist) wr("sidebarCollapsed", v ? "1" : "0");
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
    else window.scrollTo(0, 0);
  }
  // Exposed so the command palette can reuse in-place navigation. Resolves
  // once the new document is in the DOM, which is when the palette paints its
  // search hits over it.
  window.mdrfcNavigate = function(url){
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
<html lang="en"${htmlThemeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle ? esc(docTitle) : "mdrfc"}</title>
<style>
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
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg: #1a1a1a; --fg: #e0e0e0; --muted: #999; --border: #444;
    --code-bg: #2a2a2a; --link: #6cb6ff;
    --scroll-thumb: rgba(255,255,255,.20);
    --scroll-thumb-hover: rgba(255,255,255,.34);
    --hit-bg: #3d3200; --hit-fg: #ffe9a3;
    --hit-line-bg: #55450a;
    --hit-cur-bg: #b98900; --hit-cur-fg: #1a1a1a;
  }
  /* auto: follow OS, unless user forced light */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #1a1a1a; --fg: #e0e0e0; --muted: #999; --border: #444;
      --code-bg: #2a2a2a; --link: #6cb6ff;
      --scroll-thumb: rgba(255,255,255,.20);
      --scroll-thumb-hover: rgba(255,255,255,.34);
      --hit-bg: #4a3d00; --hit-fg: #ffe9a3;
      --hit-cur-bg: #b98900; --hit-cur-fg: #1a1a1a;
    }
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
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
                 "Liberation Mono", monospace;
    font-size: var(--font-size);
    line-height: 1.6;
    margin: 0;
    padding: 2rem 1rem;
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
  body.mdrfc-has-sidebar { padding-left: var(--sidebar-w); }
  html.mdrfc-sidebar-collapsed .mdrfc-sidebar { transform: translateX(-100%); }
  html.mdrfc-sidebar-collapsed body.mdrfc-has-sidebar { padding-left: 1rem; }

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
    body.mdrfc-has-sidebar { padding-left: 1rem; }
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

${reloadScript}
<script>window.__mdrfc = { dirMode: ${dirMode} };</script>
<script type="module" src="/_palette.js"></script>
<script>
(function(){
  var K = "mdrfc.";
  var SERV_THEME = ${JSON.stringify(theme)};
  var SERV_WIDTH = ${width};
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
  var resetBtn = document.getElementById("mdrfc-reset");

  function rd(k, d){ try{ var v = localStorage.getItem(K+k); return v==null?d:v; }catch(e){ return d; } }
  function wr(k, v){ try{ localStorage.setItem(K+k, v); }catch(e){} }
  function rm(k){ try{ localStorage.removeItem(K+k); }catch(e){} }

  function setTheme(v){
    if(v==="light"||v==="dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
    themeSel.value = v;
  }
  function applyFont(f){
    var fam = f ? '"'+f.replace(/"/g,"")+'", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : "";
    document.body.style.fontFamily = fam;
  }
  function applySize(s){
    if(!s){ root.style.removeProperty("--font-size"); sizeVal.textContent = ""; }
    else { root.style.setProperty("--font-size", s+"px"); sizeVal.textContent = "("+s+"px)"; }
    sizeRange.value = s || 14;
    sizeNum.value = s || 14;
  }
  function applyWidth(w){
    if(!w){ root.style.removeProperty("--content-w"); widthVal.textContent = ""; }
    else { root.style.setProperty("--content-w", w+"ch"); widthVal.textContent = "("+w+" cols)"; }
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
  applyFont(f);

  var s = rd("size", "");
  if(s) applySize(s); else { sizeRange.value = 14; sizeNum.value = 14; }

  var cw = parseInt(rd("width", ""), 10) || SERV_WIDTH;
  widthRange.value = cw;
  widthNum.value = cw;
  if(cw !== SERV_WIDTH) applyWidth(cw);

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
  resetBtn.addEventListener("click", function(){
    rm("theme"); rm("font"); rm("size"); rm("width");
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
          fontInput.placeholder = fam + " (system default)";
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
      var li = row(f.name, f.mono ? "mono" : "", false);
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
${sidebarScript}
</body>
</html>`;
}
