import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { stripAnsi, type RenderOpts } from "../util.ts";
import { listMdTreeText } from "../server.ts";

/**
 * Render markdown to terminal-friendly text.
 * Uses marked-terminal with 72-col width and text reflow.
 * If `color === false`, all ANSI codes are stripped → pure RFC monospace.
 */
export function renderTerminal(md: string, opts: RenderOpts): string {
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

  const out = marked.parse(md) as string;
  return opts.color ? out : stripAnsi(out);
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
