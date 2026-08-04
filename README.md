# mdrfc

Simple markdown viewer. **Terminal + web.** RFC-style monospace, 72-column width.

```
mdrfc README.md              # render in terminal (paged via less)
mdrfc docs/                  # directory: filetree + README
mdrfc README.md --web        # serve HTML, open browser, live-reload on edit
mdrfc docs/ --web            # serve dir with sidebar listing all .md files
cat foo.md | mdrfc           # stdin works too
```

## Why

Markdown is for *reading*, not just rendering to HTML. mdrfc gives you two fast paths from the same source:

- **Terminal** — RFC-text feel, monospace, 72-col reflow, optional color, paged through `less`.
- **Web** — same 72ch column, same monospace, but proper HTML: real links, tables, syntax-highlighted code blocks, dark/light theme. With **live reload** so editing the file refreshes the browser instantly.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1.

```sh
# run from source
bun install
bun src/main.ts README.md

# global link (so `mdrfc` works anywhere)
bun link

# or build a standalone binary (~60 MB, self-contained, no Bun needed)
bun run build
./mdrfc README.md
```

> On macOS the build step ad-hoc codesigns the binary so it isn't killed by Gatekeeper on first run.

## Usage

```
mdrfc [file]              render file to terminal (paged via less)
mdrfc [file] --web        serve rendered HTML and open browser
mdrfc                     read markdown from stdin
cat foo.md | mdrfc --web  stdin + web

FLAGS
  -w, --web                 serve via local HTTP server
  -p, --port <n>            server port (default 2119, auto-increment if busy)
      --no-open             don't auto-open browser (use with --web)
      --no-color            strip ANSI colors → pure RFC text
      --no-frontmatter      hide the frontmatter block (still stripped from body)
      --width <n>           content width in columns (default 72)
      --theme <auto|light|dark>  web color scheme (default auto)
  -h, --help                show this help
  -V, --version             show version
```

## Width / RFC style

Default width is **72 columns**, the long-standing RFC line-length convention. Both the terminal and web views share it.

- Override per-run: `mdrfc README.md --width 80`
- Pure plain-text RFC look (no color): `mdrfc README.md --no-color`

## Frontmatter

A YAML (`---`) or TOML (`+++`) block at the top of the file is parsed out of
the document instead of leaking into the body as a stray rule and heading:

```markdown
---
title: RFC 9999 — Widget Protocol
author: Riad
tags: [rfc, draft]
---

# Introduction
```

- **Terminal** — aligned `key: value` lines above a rule, then the body.
- **Web** — a definition list styled as a metadata header. `title` also becomes
  the browser page title.
- `--no-frontmatter` hides the header; the block is stripped from the body
  either way.

The parser is hand-written (no extra dependency) and covers the subset
frontmatter actually uses:

- scalars — strings, numbers, booleans, `null`/`~`, quoted values, `\uXXXX`
  and `\t`-style escapes; dates and times stay strings
- nested maps, block sequences, sequences of maps
- flow collections `[a, b]` / `{a: 1}`, including ones spanning several lines
- multi-line plain scalars (continuation lines fold onto one line)
- block scalars `|` and `>` with indentation (`|2`) and chomping (`-`, `+`)
- `#` comments, quote-aware so `https://x#y` survives
- TOML `key = value`, arrays, and `[table]` / `[table.sub]` headers

Not supported (rare in frontmatter): anchors and aliases (`&a`, `*a`, `<<`) —
an anchored map still renders, the anchor name is dropped — explicit tags
(`!!str`), YAML 1.1 `yes`/`no`/`on`/`off` booleans (kept as strings), and
hex/`.inf`/`.nan` numerics (kept as strings). Nested keys are shown flattened
(`meta.status`). Malformed frontmatter is ignored rather than fatal.

```sh
bun test    # parser test suite
```

## Directory mode

Give `mdrfc` a **directory** and it scans for `*.md` files (hidden files,
`node_modules`, `.git`, `dist`, `build` are skipped) and shows a filetree:

- **Terminal** — prints the tree, then renders the directory's `README.md`
  (or `index.md`) below a divider.
- **Web** — a fixed sidebar lists every `.md` file grouped by folder.
  Click any file to navigate; the active file is highlighted. The root path
  serves `README.md`, and live-reload still fires on save.

```sh
mdrfc docs/ --web
```

## Search

In `--web` mode, **Cmd-K** (or Ctrl-K) opens a command palette.

Serving a single file or stdin, it searches that document's headings — an empty
query lists the whole outline. Serving a directory, it also searches every
`.md` file: filenames are matched fuzzily, headings and body text by substring,
with each result linking to its nearest heading so you land on the right
section rather than the top of the file.

Filenames are ranked with [fzf](https://github.com/junegunn/fzf)'s algorithm, so
its extended syntax works:

| Query    | Matches                          |
| -------- | -------------------------------- |
| `cfg`    | fuzzy — `guide/advanced-config.md` |
| `^guide` | paths starting with `guide`      |
| `.md$`   | paths ending in `.md`            |
| `'exact` | paths containing exactly `exact` |
| `!draft` | paths *not* containing `draft`   |
| `a \| b` | either `a` or `b`                |

These operators only apply to paths, so a query using any of them filters files
and skips content search.

## Settings panel

The gear button in the web view opens theme, font and size controls, all
persisted in `localStorage`.

The font field searches every family installed on the machine — fixed-pitch
ones are tagged `mono` and sort first, since proportional text breaks the
72-column alignment, but nothing is hidden. Each row previews itself in its
own family, and an empty field names the one it falls back to.

Typing only searches. The font changes when a family is **chosen** — click a
row, or press **Enter**. Enter with no row highlighted takes the field as
typed, so a webfont you have loaded some other way works too; Enter on an
empty field returns to the system default. **Esc** or a click elsewhere
abandons the search and restores the family in force.

Families are collected from `fc-list` when fontconfig is present, plus a
direct scan of the OS font directories that reads only each font's `name` and
`post` tables.

## Live reload

With `--web` and a **file** (not stdin), mdrfc watches the file. On every save:

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

Each produces a standalone executable named `mdrfc-<os>-<arch>`.

## Layout

```
src/
  main.ts          CLI entry, flag parsing, dispatch
  util.ts          width/port helpers, stdin, less paging, ANSI strip, slugs
  frontmatter.ts   YAML/TOML frontmatter split + subset parser
  search.ts        fzf path ranking + heading/content scan, mtime-cached
  fonts.ts         installed font families via fc-list + sfnt table scan
  open.ts          cross-platform browser open
  server.ts        Bun.serve + WebSocket live-reload + file watcher + md tree
  client/
    palette.js     Cmd-K command palette (Preact + htm, served as a module)
  render/
    term.ts        marked + marked-terminal renderer; dir-mode tree
    web.ts         marked HTML + CSS template + sidebar filetree
scripts/
  postbuild.mjs    ad-hoc codesign on macOS
```

## Dependencies

Five runtime deps, none with transitive dependencies of their own:

- [`marked`](https://github.com/markedjs/marked) — markdown parser (shared by both renderers)
- [`marked-terminal`](https://github.com/mikaelbr/marked-terminal) — terminal rendering
- [`fzf`](https://github.com/ajitid/fzf-for-js) — fzf's matching algorithm, for filename ranking
- [`preact`](https://preactjs.com) + [`htm`](https://github.com/developit/htm) — the command palette

Everything else (HTTP server, WebSocket, file watch, arg parsing, browser launch) uses Bun or Node built-ins.

`preact` and `htm` ship to the browser as a single 13 KB bundle, served from
`/_preact.js` rather than inlined so it stays cached across navigation. There is
no frontend build step — the palette is authored with htm's tagged templates and
text-imported into the binary.
