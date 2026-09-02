#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { renderTerminal, renderTerminalDirectory } from "./render/term.ts";
import { startServer } from "./server.ts";
import {
  DEFAULT_TOC,
  hasBrowser,
  pageOutput,
  parseTocMode,
  readStdin,
  RFC_WIDTH,
  type Theme,
  VERSION,
} from "./util.ts";

const BANNER = `mdrfc ${VERSION}`;
const DEFAULT_PORT = 2119;

function printHelp(): void {
  console.log(`
${BANNER}
Simple markdown viewer — terminal + web. RFC-style monospace.

USAGE
  mdrfc [file]              serve rendered HTML and open browser
  mdrfc [dir]               serve dir with sidebar filetree of all .md
  mdrfc [file] --term       render file to terminal instead (paged via less)
  mdrfc [dir] --term        render directory: filetree + index (README)
  mdrfc                     read markdown from stdin
  cat foo.md | mdrfc        stdin + web

FLAGS
  -w, --web                 serve via local HTTP server (the default)
  -t, --term, --no-web      render to the terminal instead
  -p, --port <n>            server port (default ${DEFAULT_PORT}, auto-increment if busy)
  --no-open                 don't auto-open browser
      --no-color            strip ANSI colors → pure RFC text
      --no-frontmatter      hide the frontmatter block (still stripped from body)
      --width <n>           content width in columns (default ${RFC_WIDTH})
      --theme <auto|light|dark>  web color scheme (default auto)
      --toc <off|top|left|right> web table of contents (default ${DEFAULT_TOC})
  -h, --help                show this help
  -V, --version             show version

WHERE IT OPENS
  The browser is the default view. --term (-t) renders to the terminal
  instead, and so does a stdout that is not a terminal, so \`mdrfc x.md | less\`
  and \`mdrfc x.md > out.txt\` keep working; --web forces the server even then.
  An SSH session with no display also reads in the terminal, since a browser
  opened there would not be in front of you.

FONT (web view)
  Pages are set in Iosevka Brick, served by mdrfc itself, so a machine with no
  monospace font of its own reads the same as one with a dozen. The settings
  panel switches to any installed family; the bundled one is listed there too.
  A font already picked in a browser stays picked — the page offers the new
  one in a notice you accept or dismiss once, and never overwrites the choice.

TABLE OF CONTENTS (web view)
  Every heading is listed in the margin beside the text, where the list
  tracks the section being read; it returns to the top of the document
  whenever the window is too narrow to hold a margin column. --toc right
  puts it on the other side, --toc top in the flow above the document.
  An entry too long for the column reads in full on hover.
  The settings panel changes the placement without a restart.

FRONTMATTER
  A YAML (\`---\`) or TOML (\`+++\`) block at the top of the file is parsed out
  of the body and shown as a metadata header — aligned key/value lines in the
  terminal, a definition list on the web (where \`title\` also becomes the page
  title). Use --no-frontmatter to hide the header.

SEARCH (web view)
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
  mdrfc README.md --term
  mdrfc README.md --port 8080
  mdrfc README.md --no-open
  curl -sL example.com/x.md | mdrfc

WIDTH & RFC STYLE
  Default width is ${RFC_WIDTH} columns (RFC line-length convention).
  Output is monospace; color is enabled by default in TTY, disabled when piped.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      // No default: the web view is the default view, but only a flag actually
      // written asks for it, and that is what overrides a non-TTY stdout.
      web: { type: "boolean", short: "w" },
      term: { type: "boolean", short: "t", default: false },
      "no-web": { type: "boolean", default: false },
      port: { type: "string", short: "p", default: String(DEFAULT_PORT) },
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
    console.log(BANNER);
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

  // The browser is where a document is read, so that is where it opens. Three
  // things send it to the terminal instead: asking for it, a stdout that is not
  // a terminal — `mdrfc x.md | grep` wants text on the pipe, not a browser tab
  // and an empty pipe — and a session with no browser to open. An explicit
  // --web wins over all of them.
  const useWeb =
    !flag("term") &&
    !flag("no-web") &&
    (flag("web") || (process.stdout.isTTY === true && hasBrowser()));

  if (useWeb) {
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
