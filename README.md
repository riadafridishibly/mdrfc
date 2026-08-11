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

Requires [Node](https://nodejs.org) ≥ 22.18, which runs the TypeScript sources
directly by stripping the types out. There is no build step.

```sh
# run from source
npm install
node src/main.ts README.md

# global link (so `mdrfc` works anywhere)
npm link
```

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
      --toc <off|top|left|right> web table of contents (default top)
  -h, --help                show this help
  -V, --version             show version
```

## Width / RFC style

Default width is **72 columns**, the long-standing RFC line-length convention. Both the terminal and web views share it.

- Override per-run: `mdrfc README.md --width 80`
- In the web view, the settings panel has a **Content width** slider (40–200
  columns), remembered per browser. `--width` is its default; sliding back to
  that value clears the override.
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
npm test    # parser test suite
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

## Heading links

Every heading gets a slug id and a `#` handle after its text, faint until you
hover the heading. Clicking it jumps to that section *and* copies the section's
full URL, so linking someone to one part of a long document doesn't mean
hand-assembling the fragment.

The handle draws its `#` from CSS rather than holding text, so heading text
stays exactly what the markdown said — which is what the page title and the
search highlighter read.

Slugs are GitHub's, so a link written against the same document rendered
there lands on the same heading here. That means punctuation leaves the
spaces beside it behind — `## Appendix A — go-lua gotchas` is
`#appendix-a--go-lua-gotchas`, with two hyphens — repeated hyphens are never
collapsed, and letters outside ASCII are kept (`#café-notes`).

## Table of contents

The web view lists every heading of the document, under the frontmatter block
and above the text. Entries are indented relative to the shallowest heading
present, so a document whose sections all start at `##` isn't listed one step
in. A document with one heading or none gets no list.

`--toc left` or `--toc right` moves the list out of the flow and into the
margin beside the column, where it stays put as you read and lights the
section you are in. There is room for it because the text stops at 72
columns — the margin is space the document was never going to use.

The margin is measured, not assumed: the window size, the content width, the
font size and the filetree sidebar all move it, and when what is left is too
thin to read a column of links in, the list returns to the top of the
document. Widen the window and it goes back out to the margin.

Placement is a **Table of contents** setting in the panel — off, top, left or
right — remembered per browser and applied without a reload. `--toc` is its
default; choosing that value again clears the override.

## Reading position

The web view remembers where you were in each document, per path. Save the
file and live-reload puts you back at the same line; wander off to another
file in the sidebar and come back, and it is still where you left it. The
memory outlives the tab and the server too — stop mdrfc, start it again
tomorrow, and a half-read document opens half-read.

Anything you asked for explicitly outranks it — a `#fragment` in the URL, or
a result opened from the palette — so the memory only decides where a plain
visit lands.

Positions live in the browser's `localStorage`, which is scoped to the
origin, so a run that lands on a different port (2119 is taken, mdrfc takes
2120) starts fresh. The 200 most recently read documents are kept and older
entries are dropped.

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

Opening a result highlights the line you picked — the whole line, as the
palette listed it — with your query brighter inside it, and its other
occurrences in the document faintly marked. No hunting down the line by eye.
**Esc** clears the highlight.

The listed row is markdown and the page is rendered HTML, so the two are
matched with markup stripped and the hit's own section preferred; a row nothing
can be matched to still highlights the heading it belongs under. Highlighting
uses the CSS Custom Highlight API, so the markup is untouched — a browser
without it still jumps, just without the colour.

## Settings panel

The gear button in the web view opens theme, font, size, content width and
table-of-contents controls, all persisted in `localStorage`.

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

## Live reload

With `--web` and a filesystem path (anything but stdin), mdrfc watches the
directory being served — not the individual file, so an editor that saves by
renaming a temp file over the original doesn't break the watch after one save.
Directory mode watches recursively, so files added or deleted while the server
runs reach the sidebar without a restart.

Each browser tab holds a server-sent-events stream open and names the document
it is showing. An edit reloads only the tabs reading that file; a file added or
removed reloads every tab, since it changes every sidebar. A tab whose stream
comes back after the server went away reloads itself.

## Layout

```
src/
  main.ts          CLI entry, flag parsing, dispatch
  util.ts          width/port helpers, stdin, less paging, ANSI strip, slugs
  frontmatter.ts   YAML/TOML frontmatter split + subset parser
  search.ts        fzf path ranking + heading/content scan, mtime-cached
  fonts.ts         installed font families via fc-list + sfnt table scan
  open.ts          cross-platform browser open
  server.ts        node:http server + SSE live-reload + dir watcher + md tree
  types/           declarations for the one dependency that ships none
  client/
    palette.js     Cmd-K command palette (Preact + htm, served as a module)
    highlight.js   paints the picked line + query in the document (Highlight API)
  render/
    term.ts        marked + marked-terminal renderer; dir-mode tree
    web.ts         marked HTML + CSS template + sidebar filetree
test/
  harness.ts       the slice of `expect` these tests use, over node:test
```

## Dependencies

Five runtime deps, none with transitive dependencies of their own:

- [`marked`](https://github.com/markedjs/marked) — markdown parser (shared by both renderers)
- [`marked-terminal`](https://github.com/mikaelbr/marked-terminal) — terminal rendering
- [`fzf`](https://github.com/ajitid/fzf-for-js) — fzf's matching algorithm, for filename ranking
- [`preact`](https://preactjs.com) + [`htm`](https://github.com/developit/htm) — the command palette

Everything else (HTTP server, live reload, file watch, arg parsing, browser launch) uses Node built-ins.

`preact` and `htm` ship to the browser as a single 13 KB bundle, served from
`/_preact.js` rather than inlined so it stays cached across navigation. There is
no frontend build step — the palette is authored with htm's tagged templates and
read off disk at startup.
