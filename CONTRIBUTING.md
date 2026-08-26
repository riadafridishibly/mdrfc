# Contributing

## Run from a clone

```sh
npm install
node src/main.ts README.md

npm link                 # so `mdrfc` works anywhere
```

Node runs the TypeScript directly, so there is no build step while you work.
That needs Node 22.18 or newer (the published package is plain JavaScript and
only needs Node 20).

`npm install` also produces `dist/`, because `npm publish` uploads JavaScript.
It is wired to `prepare`, so you never run it by hand, and `dist/` is never
committed. Edit and test the TypeScript in `src/`.

## Checks

```sh
npm test         # test suite
npm run typecheck
```

Both also run under Bun and Deno:

```sh
bun test
deno test -A test/
```

## Layout

```
src/
  main.ts          CLI entry, flag parsing, dispatch
  util.ts          width/port helpers, stdin, less paging, ANSI strip, slugs
  frontmatter.ts   YAML/TOML frontmatter split + subset parser
  search.ts        fzf path ranking + heading/content scan, mtime-cached
  fonts.ts         installed font families via fc-list + sfnt table scan
  webfont.ts       the bundled family: @font-face rules + face lookup
  announce.ts      one-time notices about new defaults, accepted or dismissed
  open.ts          cross-platform browser open
  server.ts        node:http server + SSE live-reload + dir watcher + md tree
  client/
    palette.js     Cmd-K command palette (Preact + htm, served as a module)
    highlight.js   paints the picked line + query in the document
    mermaid.js     draws mermaid fences, plus the full-window diagram view
  render/
    term.ts        marked + marked-terminal renderer; dir-mode tree
    web.ts         marked HTML + CSS template + sidebar filetree
  webfonts/        the four subset Iosevka Brick WOFF2 faces
test/
  harness.ts       the slice of `expect` these tests use, over node:test
```

## Dependencies

Five runtime deps, none with transitive dependencies of their own: `marked`,
`marked-terminal`, `fzf`, `preact` and `htm`. Everything else — HTTP server,
live reload, file watching, arg parsing, browser launch — is Node built-ins.
Keep it that way where you can.

`mermaid` is a dev dependency: only its browser build ships, copied into the
package by `npm run build`. There is no frontend build step — files in
`src/client/` are served as-is.

## Notes

- Both views share one width (72 columns by default), so a change to one
  usually needs the other.
- Web features should degrade: with JavaScript off, the page is still the
  document.
- Only macOS is verified. Linux mostly works; Windows is untested.
