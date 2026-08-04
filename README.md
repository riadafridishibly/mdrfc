# mdweb

Simple markdown viewer. **Terminal + web.** RFC-style monospace, 72-column width.

```
mdweb README.md              # render in terminal (paged via less)
mdweb README.md --web        # serve HTML, open browser, live-reload on edit
cat foo.md | mdweb           # stdin works too
```

## Why

Markdown is for *reading*, not just rendering to HTML. mdweb gives you two fast paths from the same source:

- **Terminal** — RFC-text feel, monospace, 72-col reflow, optional color, paged through `less`.
- **Web** — same 72ch column, same monospace, but proper HTML: real links, tables, syntax-highlighted code blocks, dark/light theme. With **live reload** so editing the file refreshes the browser instantly.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1.

```sh
# run from source
bun install
bun src/main.ts README.md

# global link (so `mdweb` works anywhere)
bun link

# or build a standalone binary (~60 MB, self-contained, no Bun needed)
bun run build
./mdweb README.md
```

> On macOS the build step ad-hoc codesigns the binary so it isn't killed by Gatekeeper on first run.

## Usage

```
mdweb [file]              render file to terminal (paged via less)
mdweb [file] --web        serve rendered HTML and open browser
mdweb                     read markdown from stdin
cat foo.md | mdweb --web  stdin + web

FLAGS
  -w, --web                 serve via local HTTP server
  -p, --port <n>            server port (default 3000, auto-increment if busy)
      --no-open             don't auto-open browser (use with --web)
      --no-color            strip ANSI colors → pure RFC text
      --width <n>           content width in columns (default 72)
      --theme <auto|light|dark>  web color scheme (default auto)
  -h, --help                show this help
  -V, --version             show version
```

## Width / RFC style

Default width is **72 columns**, the long-standing RFC line-length convention. Both the terminal and web views share it.

- Override per-run: `mdweb README.md --width 80`
- Pure plain-text RFC look (no color): `mdweb README.md --no-color`

## Live reload

With `--web` and a **file** (not stdin), mdweb watches the file. On every save:

1. File is re-read.
2. All connected browser tabs get a WebSocket `reload` ping and refresh.

The reload client reconnects automatically if the server restarts.

## Cross-platform binaries

```sh
bun run build:macos-arm64   # Apple Silicon
bun run build:macos-x64     # Intel Mac
bun run build:linux-arm64
bun run build:linux-x64
```

Each produces a standalone executable named `mdweb-<os>-<arch>`.

## Layout

```
src/
  main.ts          CLI entry, flag parsing, dispatch
  util.ts          width/port helpers, stdin, less paging, ANSI strip
  open.ts          cross-platform browser open
  server.ts        Bun.serve + WebSocket live-reload + file watcher
  render/
    term.ts        marked + marked-terminal renderer
    web.ts         marked HTML + CSS template
scripts/
  postbuild.mjs    ad-hoc codesign on macOS
```

## Dependencies

Only two runtime deps:

- [`marked`](https://github.com/markedjs/marked) — markdown parser (shared by both renderers)
- [`marked-terminal`](https://github.com/mikaelbr/marked-terminal) — terminal rendering

Everything else (HTTP server, WebSocket, file watch, arg parsing, browser launch) uses Bun or Node built-ins.
