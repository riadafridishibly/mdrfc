import { Marked } from "marked";
import type { RenderOpts, Theme } from "../util.ts";

/**
 * Render markdown → standalone HTML.
 * RFC-style: monospace, 72ch max content width, centered.
 * Injects a tiny WebSocket client for live-reload when `reloadToken` is set.
 */
export function renderWeb(
  md: string,
  opts: RenderOpts,
  reloadToken?: string
): string {
  const marked = new Marked();
  const body = marked.parse(md) as string;
  const theme = opts.theme;
  return htmlTemplate(body, opts.width, theme, reloadToken);
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdweb</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #666666;
    --border: #d0d0d0;
    --code-bg: #f4f4f4;
    --link: #2563eb;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg: #1a1a1a; --fg: #e0e0e0; --muted: #999; --border: #444;
    --code-bg: #2a2a2a; --link: #6cb6ff;
  }}
  html[data-theme="light"] { color-scheme: light; }
  html[data-theme="dark"] { color-scheme: dark; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
                 "Liberation Mono", monospace;
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
    padding: 2rem 1rem;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: ${width}ch;
    margin: 0 auto;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.5em; }
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
</style>
</head>
<body${theme === "light" ? ' data-theme="light"' : theme === "dark" ? ' data-theme="dark"' : ""}>
<main>
${body}
</main>
${reloadScript}
</body>
</html>`;
}
