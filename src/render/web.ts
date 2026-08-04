import { Marked } from "marked";
import type { RenderOpts, Theme } from "../util.ts";

/**
 * Render markdown → standalone HTML.
 * RFC-style: monospace, 72ch max content width, centered.
 * Injects a tiny WebSocket client for live-reload when `reloadToken` is set,
 * and a settings panel (theme / font / size) persisted in localStorage.
 */
export function renderWeb(
  md: string,
  opts: RenderOpts,
  reloadToken?: string
): string {
  const marked = new Marked();
  const body = addHeadingIds(marked.parse(md) as string);
  const theme = opts.theme;
  return htmlTemplate(
    openExternalLinksInNewTab(body),
    opts.width,
    theme,
    reloadToken
  );
}

/**
 * Add `id="<slug>"` to every <h1>..<h6> so anchor links (`#section`)
 * actually scroll. marked core doesn't emit heading IDs.
 * Slug: lowercase, trim, collapse spaces/punct to hyphens, dedupe.
 */
function addHeadingIds(html: string): string {
  const seen = new Map<string, number>();
  const slugify = (text: string): string =>
    text
      .replace(/<[^>]+>/g, "") // strip inline tags
      .toLowerCase()
      .replace(/[^\w\s-]/g, "") // drop punctuation
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section";
  const uniqueSlug = (slug: string): string => {
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n === 0 ? slug : `${slug}-${n}`;
  };
  return html.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, inner: string) => {
      const id = uniqueSlug(slugify(inner));
      return `<h${level} id="${id}">${inner}</h${level}>`;
    }
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
  reloadToken?: string
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

  return `<!doctype html>
<html lang="en"${htmlThemeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdweb</title>
<style>
  :root {
    --font-size: 14px;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #666666;
    --border: #d0d0d0;
    --code-bg: #f4f4f4;
    --link: #2563eb;
  }
  html[data-theme="light"] { color-scheme: light; }
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg: #1a1a1a; --fg: #e0e0e0; --muted: #999; --border: #444;
    --code-bg: #2a2a2a; --link: #6cb6ff;
  }
  /* auto: follow OS, unless user forced light */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #1a1a1a; --fg: #e0e0e0; --muted: #999; --border: #444;
      --code-bg: #2a2a2a; --link: #6cb6ff;
    }
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
    max-width: ${width}ch;
    margin: 0 auto;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.5em; scroll-margin-top: 1rem; }
  h1 { font-size: 1.6em; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1.05em; }
  p { margin: 0.6em 0; }
  a { color: var(--link); }
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
    background: var(--code-bg);
    padding: 1em;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.4;
  }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 1em 0; font-size: 0.92em; }
  th, td { border: 1px solid var(--border); padding: 0.4em 0.7em; text-align: left; }
  th { background: var(--code-bg); }
  img { max-width: 100%; }

  /* ── settings panel ─────────────────────────────────────────── */
  #mdweb-gear {
    position: fixed; top: 12px; right: 12px; z-index: 50;
    width: 34px; height: 34px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--code-bg); color: var(--fg);
    cursor: pointer; font-size: 16px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    opacity: .55; transition: opacity .15s;
  }
  #mdweb-gear:hover { opacity: 1; }
  #mdweb-panel {
    position: fixed; top: 0; right: 0; height: 100vh; width: 280px;
    background: var(--bg); border-left: 1px solid var(--border);
    box-shadow: -4px 0 18px rgba(0,0,0,.10);
    transform: translateX(105%); transition: transform .2s ease;
    z-index: 60; padding: 18px 16px; box-sizing: border-box; overflow-y: auto;
    font-size: 13px;
  }
  #mdweb-panel.open { transform: translateX(0); }
  #mdweb-panel h2 { margin: 0 0 14px; font-size: 14px; border: 0; padding: 0; }
  #mdweb-panel .row { margin-bottom: 14px; }
  #mdweb-panel label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
  #mdweb-panel select,
  #mdweb-panel input[type=text],
  #mdweb-panel input[type=number] {
    width: 100%; box-sizing: border-box; font-family: inherit; font-size: 13px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 5px 6px;
  }
  #mdweb-panel .size-row { display: flex; gap: 8px; align-items: center; }
  #mdweb-panel input[type=range] { flex: 1; }
  #mdweb-panel .close {
    position: absolute; top: 8px; right: 10px;
    background: none; border: 0; color: var(--muted); font-size: 20px;
    cursor: pointer; line-height: 1;
  }
  #mdweb-panel button.act {
    width: 100%; padding: 7px; border: 1px solid var(--border);
    background: var(--code-bg); color: var(--fg); border-radius: 4px;
    cursor: pointer; font-family: inherit; font-size: 13px;
  }
</style>
</head>
<body>
<main>
${body}
</main>

<button id="mdweb-gear" type="button" title="Settings" aria-label="Settings">&#9881;</button>
<div id="mdweb-panel" role="dialog" aria-label="Settings" aria-hidden="true">
  <button type="button" class="close" id="mdweb-close" aria-label="Close">&times;</button>
  <h2>Settings</h2>
  <div class="row">
    <label for="mdweb-theme">Theme</label>
    <select id="mdweb-theme">
      <option value="auto">Auto (follow OS)</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </div>
  <div class="row">
    <label for="mdweb-font">Font</label>
    <select id="mdweb-font"></select>
  </div>
  <div class="row">
    <label for="mdweb-font-custom">Custom font name</label>
    <input id="mdweb-font-custom" type="text" placeholder="e.g. Comic Sans MS" spellcheck="false">
  </div>
  <div class="row">
    <label for="mdweb-size">Font size <span id="mdweb-size-val"></span></label>
    <div class="size-row">
      <input id="mdweb-size" type="range" min="10" max="28" step="1" value="14">
      <input id="mdweb-size-num" type="number" min="10" max="28" step="1" value="14" style="width:58px">
    </div>
  </div>
  <div class="row">
    <button type="button" class="act" id="mdweb-reset">Reset to defaults</button>
  </div>
</div>

${reloadScript}
<script>
(function(){
  var K = "mdweb.";
  var SERV_THEME = ${JSON.stringify(theme)};
  var root = document.documentElement;
  var gear = document.getElementById("mdweb-gear");
  var panel = document.getElementById("mdweb-panel");
  var closeBtn = document.getElementById("mdweb-close");
  var themeSel = document.getElementById("mdweb-theme");
  var fontSel = document.getElementById("mdweb-font");
  var fontCustom = document.getElementById("mdweb-font-custom");
  var sizeRange = document.getElementById("mdweb-size");
  var sizeNum = document.getElementById("mdweb-size-num");
  var sizeVal = document.getElementById("mdweb-size-val");
  var resetBtn = document.getElementById("mdweb-reset");

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

  // init
  var t = rd("theme", SERV_THEME || "auto");
  if(t!=="light"&&t!=="dark") t = "auto";
  setTheme(t);

  var f = rd("font", "");
  fontCustom.value = f;
  applyFont(f);

  var s = rd("size", "");
  if(s) applySize(s); else { sizeRange.value = 14; sizeNum.value = 14; }

  // events
  themeSel.addEventListener("change", function(){
    setTheme(themeSel.value); wr("theme", themeSel.value);
  });
  fontSel.addEventListener("change", function(){
    var v = fontSel.value;
    if(!v) return;
    fontCustom.value = v;
    applyFont(v); wr("font", v);
  });
  fontCustom.addEventListener("input", function(){
    var v = fontCustom.value.trim();
    applyFont(v); wr("font", v);
    fontSel.value = v && Array.prototype.some.call(fontSel.options, function(o){ return o.value===v; }) ? v : "";
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
  resetBtn.addEventListener("click", function(){
    rm("theme"); rm("font"); rm("size");
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

  var fontsLoaded = false;
  function loadFonts(){
    if(fontsLoaded) return; fontsLoaded = true;
    fetch("/_fonts").then(function(r){ return r.json(); }).then(function(list){
      var cur = fontCustom.value.trim();
      fontSel.innerHTML = "";
      var placeholder = document.createElement("option");
      placeholder.value = ""; placeholder.textContent = cur ? "(custom: "+cur+")" : "(default)";
      fontSel.appendChild(placeholder);
      if(list && list.length){
        var sep = document.createElement("option");
        sep.disabled = true; sep.textContent = "— system monospace —";
        fontSel.appendChild(sep);
        list.forEach(function(name){
          var o = document.createElement("option");
          o.value = name; o.textContent = name;
          fontSel.appendChild(o);
        });
      }
      fontSel.value = cur && Array.prototype.some.call(fontSel.options, function(o){ return o.value===cur; }) ? cur : "";
    }).catch(function(){ /* fonts endpoint unavailable; picker stays minimal */ });
  }
})();
</script>
</body>
</html>`;
}
