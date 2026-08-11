import { spawn } from "node:child_process";
import net from "node:net";

export type Theme = "auto" | "light" | "dark";

/**
 * Where the table of contents sits (web only). `left`/`right` put it in the
 * margin beside the column and fall back to `top` when there is no room.
 */
export type TocMode = "off" | "top" | "left" | "right";

export interface RenderOpts {
  width: number;
  color: boolean;
  theme: Theme;
  /** Show the parsed frontmatter as a metadata header (it is stripped either way). */
  frontmatter: boolean;
  /** Table of contents placement; the reader can override it in settings. */
  toc?: TocMode;
}

export const RFC_WIDTH = 72;

export const TOC_MODES: TocMode[] = ["off", "top", "left", "right"];
export const DEFAULT_TOC: TocMode = "top";

/** A table-of-contents placement, or the default when the name is not one. */
export function parseTocMode(v: unknown): TocMode {
  return TOC_MODES.includes(v as TocMode) ? (v as TocMode) : DEFAULT_TOC;
}

/** Directories skipped when scanning for markdown files. */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "­",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  sect: "§",
  para: "¶",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

// The Latin-1 entities run in code point order from U+00C0, `times` and
// `divide` among them. Named separately they would be sixty-four more lines
// saying the same thing.
for (const [i, name] of (
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml " +
  "Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times " +
  "Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc " +
  "atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc " +
  "iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute " +
  "ucirc uuml yacute thorn yuml"
)
  .split(" ")
  .entries()) {
  NAMED_ENTITIES[name] = String.fromCharCode(0xc0 + i);
}

/**
 * Undo HTML entities, so slugs and titles read as the rendered page does.
 * Covers the escapes marked emits and the ones an author writes by hand;
 * anything else is left as written, since a slug drops `&` and `;` anyway.
 * One pass, so an escaped ampersand (`&amp;lt;`) does not decode twice.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? m;
    const code = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/**
 * Slug for a heading, matching the ids emitted into the rendered HTML:
 * lowercase, punctuation dropped, each remaining space a hyphen.
 * Callers dedupe repeated slugs themselves (`-1`, `-2`, ...).
 *
 * This is GitHub's slug, deliberately — links written against a document
 * rendered there have to land here too. Hence the two rules that look like
 * bugs: dropped punctuation leaves the spaces that surrounded it behind, so
 * `A — b` slugs to `a--b`, and runs of hyphens are never collapsed. Letters
 * outside ASCII are kept, combining marks with them, and only a literal space
 * becomes a hyphen — a tab or a newline is dropped like any other character
 * outside the set.
 */
export function slugifyHeading(text: string): string {
  return (
    decodeEntities(text.replace(/<[^>]+>/g, "")) // strip inline tags
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, "") // drop punctuation and symbols
      .replace(/ /g, "-") || "section"
  );
}

/** Strip ANSI escape codes (color strip for --no-color mode). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Read all of stdin as utf8 text. */
export async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Probe whether a TCP port is free. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

/** Find first free port starting at `start`, up to `maxTries` increments. */
export async function findFreePort(start: number, maxTries = 50): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found starting at ${start}`);
}

/**
 * Pipe rendered text through `less -RFX` if stdout is a TTY and `less` exists.
 * -R  = pass through raw ANSI (colors)
 * -F  = quit if content fits one screen
 * -X  = don't clear screen on exit
 * -K  = exit on SIGINT
 * Otherwise just print to stdout.
 */
export function pageOutput(text: string): void {
  const isTTY = process.stdout.isTTY === true;
  if (!isTTY) {
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    return;
  }
  const p = spawn("less", ["-RFXK"], { stdio: ["pipe", "inherit", "inherit"] });
  p.stdin.write(text);
  p.stdin.end();
  p.on("error", () => {
    // less not available → just print
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
  });
}
