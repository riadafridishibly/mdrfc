#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { renderTerminal } from "./render/term.ts";
import { startServer } from "./server.ts";
import {
  pageOutput,
  readStdin,
  RFC_WIDTH,
  type Theme,
} from "./util.ts";

const VERSION = "mdweb 0.1.0";

function printHelp(): void {
  console.log(`
${VERSION}
Simple markdown viewer — terminal + web. RFC-style monospace.

USAGE
  mdweb [file]              render file to terminal (paged via less)
  mdweb [file] --web        serve rendered HTML and open browser
  mdweb                     read markdown from stdin
  cat foo.md | mdweb --web  stdin + web

FLAGS
  -w, --web                 serve via local HTTP server
  -p, --port <n>            server port (default 3000, auto-increment if busy)
  --no-open                 don't auto-open browser (use with --web)
      --no-color            strip ANSI colors → pure RFC text
      --width <n>           content width in columns (default ${RFC_WIDTH})
      --theme <auto|light|dark>  web color scheme (default auto)
  -h, --help                show this help
  -V, --version             show version

EXAMPLES
  mdweb README.md
  mdweb README.md --web --port 8080
  mdweb README.md --web --no-open
  curl -sL example.com/x.md | mdweb

WIDTH & RFC STYLE
  Default width is ${RFC_WIDTH} columns (RFC line-length convention).
  Output is monospace; color is enabled by default in TTY, disabled when piped.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      web: { type: "boolean", short: "w", default: false },
      port: { type: "string", default: "3000" },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      color: { type: "boolean", default: true },
      "no-color": { type: "boolean", default: false },
      width: { type: "string" },
      theme: { type: "string", default: "auto" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  const source = positionals[0];
  const content = source
    ? readFileSync(source, "utf8")
    : await readStdin();

  if (!content.trim()) {
    console.error("mdweb: no input (provide a file or pipe markdown via stdin)");
    process.exit(1);
  }

  const theme = (["auto", "light", "dark"].includes(values.theme as string)
    ? values.theme
    : "auto") as Theme;

  const renderOpts = {
    width: values.width ? parseInt(values.width as string, 10) : RFC_WIDTH,
    color: values.color && !values["no-color"],
    theme,
  };

  if (values.web) {
    const port = parseInt(values.port as string, 10) || 3000;
    const shouldOpen = values.open && !values["no-open"];
    await startServer({
      content,
      source,
      port,
      open: shouldOpen,
      ...renderOpts,
    });
  } else {
    const out = renderTerminal(content, renderOpts);
    pageOutput(out);
  }
}

main().catch((err) => {
  console.error(`mdweb: ${err?.message ?? err}`);
  process.exit(1);
});
