import { readFileSync } from "node:fs";
import { VERSION } from "./util.ts";

/**
 * Diagrams from ```mermaid fences, drawn in the browser by mermaid itself.
 *
 * mermaid is a devDependency, not a runtime one: 84 MB unpacked in
 * node_modules against the one 3.5 MB browser build a reader actually needs.
 * `npm run build` copies that build next to the other client modules, so the
 * published package carries it and a diagram draws with no network — the same
 * bargain the bundled typeface makes. A clone has no `dist/`, so the loader
 * below falls back to resolving it out of node_modules.
 *
 * The bundle is only ever fetched by a page that has a diagram on it, and the
 * page names it under the running version, so it can be cached forever.
 */

export const MERMAID_FILE = "mermaid.min.js";

/** Everything the bundle route answers, current version or not. */
export const MERMAID_ROOT = "/_mermaid/";

/**
 * URL the bundle is actually served on. Versioned like the faces are: 3.5 MB
 * is not worth re-fetching on every reload, and an upgraded mermaid still
 * reaches a reader who has the old one cached, under a URL they have never
 * seen.
 */
export const MERMAID_URL = `${MERMAID_ROOT}${VERSION}/${MERMAID_FILE}`;

/** The init module, which loads the bundle above once a diagram is on the page. */
export const MERMAID_INIT_URL = "/_mermaid-init.js";

let bundle: Buffer | null | undefined;

/**
 * The browser build's bytes, or null if this install has neither a built
 * `dist/client/` nor mermaid in node_modules — in which case every diagram
 * stays the source text it was written as, which still reads.
 */
export function readMermaidBundle(): Buffer | null {
  if (bundle !== undefined) return bundle;
  bundle = null;
  for (const at of candidates()) {
    try {
      bundle = readFileSync(at);
      break;
    } catch {
      // try the next place it could be
    }
  }
  return bundle;
}

/** Built package first, clone second. */
function candidates(): URL[] {
  const out = [new URL(`./client/${MERMAID_FILE}`, import.meta.url)];
  try {
    out.push(new URL(import.meta.resolve(`mermaid/dist/${MERMAID_FILE}`)));
  } catch {
    // not installed; the published package does not depend on it
  }
  return out;
}
