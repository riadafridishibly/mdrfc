import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { stripAnsi, type RenderOpts } from "../util.ts";

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
