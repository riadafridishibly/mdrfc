/**
 * `marked-terminal` ships no types. Only the one extension factory is used,
 * and `marked` takes the result as an opaque extension.
 */
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>
  ): MarkedExtension;
}
