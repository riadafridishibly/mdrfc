import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { stripAnsi, type RenderOpts } from "../util.ts";
import { listMdTreeText } from "../server.ts";
import { flattenFrontmatter, parseFrontmatter } from "../frontmatter.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Render markdown to terminal-friendly text.
 * Uses marked-terminal with 72-col width and text reflow.
 * Frontmatter is stripped from the body and, unless disabled, printed as an
 * RFC-style key/value header above it.
 * If `color === false`, all ANSI codes are stripped → pure RFC monospace.
 */
export function renderTerminal(md: string, opts: RenderOpts): string {
  const fm = parseFrontmatter(md);
  const marked = new Marked();
  marked.use(
    markedTerminal({
      width: opts.width,
      reflowText: true,
      // keep it modest — terminal markdown viewers tend to over-color
      theme: {
        // defaults are fine; left here as hook for future theming
      },
    })
  );

  const header = opts.frontmatter ? renderFrontmatterText(fm.data, opts.width) : "";
  const out = header + (marked.parse(fm.content) as string);
  return opts.color ? out : stripAnsi(out);
}

/**
 * Frontmatter as an aligned key/value block, closed by a rule.
 * Values that exceed the remaining width wrap under the value column.
 */
function renderFrontmatterText(
  data: Record<string, unknown>,
  width: number
): string {
  const pairs = flattenFrontmatter(data as Parameters<typeof flattenFrontmatter>[0]);
  if (!pairs.length) return "";

  const keyWidth = Math.min(Math.max(...pairs.map(([k]) => k.length)), 20);
  const gutter = keyWidth + 2;
  const lines: string[] = [];
  for (const [key, value] of pairs) {
    const label = (key + ":").padEnd(gutter).slice(0, Math.max(gutter, key.length + 2));
    const pad = " ".repeat(gutter);
    const chunks = value
      .split("\n")
      .flatMap((para) => wrap(para, Math.max(width - gutter, 20)));
    const [first = "", ...rest] = chunks;
    lines.push(first ? `${DIM}${label}${RESET}${BOLD}${first}${RESET}` : `${DIM}${label.trimEnd()}${RESET}`);
    for (const r of rest) lines.push(pad + r);
  }
  return lines.join("\n") + "\n" + DIM + "─".repeat(width) + RESET + "\n\n";
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Terminal directory mode: print a filetree of every .md file under `base`,
 * then render the index (README) content below a divider.
 */
export function renderTerminalDirectory(
  content: string,
  base: string,
  opts: RenderOpts
): string {
  const tree = listMdTreeText(base);
  const sep = "─".repeat(Math.min(opts.width, 72));
  const indexBlock = content.trim()
    ? sep + "\n" + renderTerminal(content, opts)
    : "(no README.md found in this directory)\n";
  return tree + "\n" + sep + "\n" + indexBlock;
}
