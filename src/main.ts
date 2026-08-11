#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { renderTerminal, renderTerminalDirectory } from "./render/term.ts";
import { startServer } from "./server.ts";
import {
  DEFAULT_TOC,
  pageOutput,
  parseTocMode,
  readStdin,
  RFC_WIDTH,
  type Theme,
} from "./util.ts";

const VERSION = "mdrfc 0.1.0";
const DEFAULT_PORT = 2119;

function printHelp(): void {
  console.log(`
${VERSION}
Simple markdown viewer — terminal + web. RFC-style monospace.

USAGE
  mdrfc [file]              render file to terminal (paged via less)
  mdrfc [dir]              render directory: filetree + index (README)
  mdrfc [file] --web        serve rendered HTML and open browser
  mdrfc [dir] --web         serve dir with sidebar filetree of all .md
  mdrfc                     read markdown from stdin
  cat foo.md | mdrfc --web  stdin + web

FLAGS
  -w, --web                 serve via local HTTP server
  -p, --port <n>            server port (default ${DEFAULT_PORT}, auto-increment if busy)
  --no-open                 don't auto-open browser (use with --web)
      --no-color            strip ANSI colors → pure RFC text
      --no-frontmatter      hide the frontmatter block (still stripped from body)
      --width <n>           content width in columns (default ${RFC_WIDTH})
      --theme <auto|light|dark>  web color scheme (default auto)
      --toc <off|top|left|right> web table of contents (default ${DEFAULT_TOC})
  -h, --help                show this help
  -V, --version             show version

TABLE OF CONTENTS (--web)
  Every heading is listed above the document, under the frontmatter block.
  --toc left or --toc right moves the list into the margin beside the text,
  where it tracks the section being read; it returns to the top of the
  document whenever the window is too narrow to hold a margin column.
  The settings panel changes the placement without a restart.

FRONTMATTER
  A YAML (\`---\`) or TOML (\`+++\`) block at the top of the file is parsed out
  of the body and shown as a metadata header — aligned key/value lines in the
  terminal, a definition list on the web (where \`title\` also becomes the page
  title). Use --no-frontmatter to hide the header.

SEARCH (--web)
  Cmd-K / Ctrl-K opens a command palette. On a single file it searches that
  document's headings; on a directory it also searches filenames, headings
  and body text, jumping to the nearest heading. Filenames are ranked with
  fzf, so ^starts, ends$, 'exact, !omit and a|b work — these apply to paths
  only, so such a query filters files and skips content search.
  Opening a result highlights the line it listed, the query brighter within
  it and its other occurrences faintly; Esc clears the highlight.

DIRECTORY MODE
  Passing a directory instead of a file scans it for *.md files (hidden
  files and node_modules/.git/etc. are skipped) and shows a filetree:
    - terminal: prints the tree, then renders README.md (or index.md) below
    - web:      fixed sidebar lists every .md; click to navigate; the root
                path serves README.md with live-reload still active

EXAMPLES
  mdrfc README.md
  mdrfc README.md --web --port 8080
  mdrfc README.md --web --no-open
  curl -sL example.com/x.md | mdrfc

WIDTH & RFC STYLE
  Default width is ${RFC_WIDTH} columns (RFC line-length convention).
  Output is monospace; color is enabled by default in TTY, disabled when piped.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      web: { type: "boolean", short: "w", default: false },
      port: { type: "string", default: String(DEFAULT_PORT) },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      color: { type: "boolean", default: true },
      "no-color": { type: "boolean", default: false },
      frontmatter: { type: "boolean", default: true },
      "no-frontmatter": { type: "boolean", default: false },
      width: { type: "string" },
      theme: { type: "string", default: "auto" },
      toc: { type: "string", default: DEFAULT_TOC },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // Parsing is non-strict, so an unrecognised `--flag=value` arrives as a
  // string; only a flag actually set counts as on.
  const flag = (name: string): boolean => values[name] === true;

  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  const source = positionals[0];
  let content: string;
  let sourceFile: string | undefined;
  let baseDir: string | undefined;
  let dirMode = false;

  if (source) {
    const st = statSync(source);
    if (st.isDirectory()) {
      // Directory mode: show a filetree of every .md under it.
      dirMode = true;
      const dir = pathResolve(source);
      baseDir = dir;
      const indexCandidates = ["README.md", "readme.md", "INDEX.md", "index.md"];
      const index = indexCandidates
        .map((n) => pathResolve(dir, n))
        .find((p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        });
      sourceFile = index;
      content = index ? readFileSync(index, "utf8") : "";
    } else {
      sourceFile = source;
      content = readFileSync(source, "utf8");
    }
  } else {
    content = await readStdin();
  }

  if (!content.trim() && !dirMode) {
    console.error("mdrfc: no input (provide a file or pipe markdown via stdin)");
    process.exit(1);
  }

  const theme = (["auto", "light", "dark"].includes(values.theme as string)
    ? values.theme
    : "auto") as Theme;

  const renderOpts = {
    width: values.width ? parseInt(values.width as string, 10) : RFC_WIDTH,
    color: flag("color") && !flag("no-color"),
    theme,
    frontmatter: flag("frontmatter") && !flag("no-frontmatter"),
    toc: parseTocMode(values.toc),
  };

  if (values.web) {
    const port = parseInt(values.port as string, 10) || DEFAULT_PORT;
    const shouldOpen = flag("open") && !flag("no-open");
    await startServer({
      content,
      source: sourceFile,
      baseDir,
      dirMode,
      port,
      open: shouldOpen,
      ...renderOpts,
    });
  } else {
    const out = dirMode
      ? renderTerminalDirectory(content, baseDir!, renderOpts)
      : renderTerminal(content, renderOpts);
    pageOutput(out);
  }
}

main().catch((err) => {
  console.error(`mdrfc: ${err?.message ?? err}`);
  process.exit(1);
});
