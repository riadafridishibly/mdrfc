import { watch, readFileSync, readdirSync } from "node:fs";
import {
  dirname,
  basename,
  resolve as pathResolve,
  relative as pathRelative,
  sep,
} from "node:path";
import { renderWeb, type TreeNode } from "./render/web.ts";
import { findFreePort, SKIP_DIRS } from "./util.ts";
import { openBrowser } from "./open.ts";
import { listSystemFonts } from "./fonts.ts";
import { isExtendedQuery, search } from "./search.ts";
import type { RenderOpts } from "./util.ts";
import preactSrc from "htm/preact/standalone.module.js" with { type: "text" };
import paletteSrc from "./client/palette.js" with { type: "text" };

export interface ServerOpts extends RenderOpts {
  content: string;
  source?: string; // file path (for live-reload watch). undefined = stdin
  baseDir?: string; // explicit base directory (directory mode). defaults to dirname(source)
  dirMode?: boolean; // serving a directory tree of markdown files
  port: number;
  open: boolean;
}

/**
 * Build a tree of every `.md` file under `base`, sorted dirs-first then alpha.
 * Hidden files/dirs and noisy dependency/VCS dirs are excluded.
 * Empty directories (no .md descendants) are pruned.
 */
export function buildMdTree(base: string): TreeNode {
  const root: TreeNode = { name: basename(base) || base, path: "", dir: true, children: [] };
  const walk = (absDir: string, node: TreeNode): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory();
      const bd = b.isDirectory();
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = pathResolve(absDir, e.name);
      const rel = pathRelative(base, abs);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const child: TreeNode = { name: e.name, path: rel, dir: true, children: [] };
        walk(abs, child);
        if (child.children.length) node.children.push(child);
      } else if (e.name.toLowerCase().endsWith(".md")) {
        node.children.push({ name: e.name, path: rel, dir: false });
      }
    }
  };
  walk(base, root);
  return root;
}

/** Render the md tree as plain indented text (terminal directory mode). */
export function listMdTreeText(base: string): string {
  const tree = buildMdTree(base);
  const lines: string[] = [];
  const render = (nodes: TreeNode[], prefix: string, isLast: boolean[]): void => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      const branch = prefix + (last ? "└── " : "├── ");
      lines.push(branch + n.name);
      if (n.dir) {
        const nextPrefix = prefix + (last ? "    " : "│   ");
        render(n.children, nextPrefix, [...isLast, last]);
      }
    });
  };
  lines.push(tree.name + "/");
  render(tree.children, "", []);
  return lines.join("\n");
}

/**
 * Start local HTTP server serving the rendered markdown.
 * Live-reload via WebSocket when a source file is provided.
 */
export async function startServer(opts: ServerOpts): Promise<void> {
  const port = await findFreePort(opts.port);
  const url = `http://localhost:${port}`;

  let content = opts.content;
  const sockets = new Set<WebSocket>();

  // Base directory used to resolve internal (relative) markdown links.
  // Explicit baseDir wins (directory mode); otherwise derive from source file.
  // null = stdin (no filesystem context).
  const baseDir = opts.baseDir ?? (opts.source ? pathResolve(dirname(opts.source)) : null);

  // Filetree (directory mode): one scan at startup. New/deleted .md files
  // need a restart to appear, but edited content live-reloads as usual.
  const tree = opts.dirMode && baseDir ? buildMdTree(baseDir) : null;

  // Live reload: watch source file, re-render, ping clients.
  if (opts.source) {
    let debounce: Timer | null = null;
    watch(opts.source, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          content = readFileSync(opts.source!, "utf8");
          for (const ws of sockets) {
            if (ws.readyState === WebSocket.OPEN) ws.send("reload");
          }
        } catch {
          /* file may be mid-write; skip */
        }
      }, 100);
    });
  }

  /**
   * Resolve a request pathname to a markdown file under baseDir.
   * Returns null if not allowed (stdin mode, traversal, non-md, missing).
   * Decodes percent-encoding and treats the root path as the source file.
   */
  function resolveRequestedFile(pathname: string): string | null {
    if (!baseDir) return null;
    let rel = decodeURIComponent(pathname);
    if (rel === "/") return null; // root served from cached `content`
    // strip leading slash so it resolves relative to baseDir
    rel = rel.replace(/^\/+/, "");
    const abs = pathResolve(baseDir, rel);
    // path traversal guard: must stay inside baseDir
    const inside = pathRelative(baseDir, abs);
    if (inside.startsWith("..") || inside.includes(`..${sep}`)) return null;
    if (!abs.toLowerCase().endsWith(".md")) return null;
    return abs;
  }

  /** Render `md`, or return a 404 page if null/empty. */
  function htmlResponse(md: string | null, currentRel: string, status = 200): Response {
    const body = md ?? "# Not found\n\nNo such markdown file.\n";
    const html = renderWeb(
      body,
      opts,
      opts.source ? "1" : undefined,
      tree,
      currentRel
    );
    return new Response(html, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const server = Bun.serve({
    port,
    development: false,
    fetch(req, server) {
      const u = new URL(req.url);

      // WebSocket upgrade endpoint for live reload
      if (u.pathname === "/_reload") {
        const ok = server.upgrade(req);
        if (ok) return undefined;
        return new Response("Upgrade required", { status: 426 });
      }

      // System monospace font list for the settings panel
      if (u.pathname === "/_fonts") {
        return new Response(JSON.stringify(listSystemFonts()), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      // Command palette runtime. Served as separate modules rather than inlined
      // so the ~13 KB bundle isn't re-sent with every in-place navigation —
      // that only refetches the document, so these are not requested again.
      // Never cached: a viewer that live-reloads must not keep serving a stale
      // script after the binary it came from has changed underneath it.
      if (u.pathname === "/_preact.js" || u.pathname === "/_palette.js") {
        return new Response(u.pathname === "/_preact.js" ? preactSrc : paletteSrc, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      // Full-text search across the served directory. `extended` tells the
      // palette the query was read as a path filter, so it can say why no
      // content results came back.
      if (u.pathname === "/_search") {
        const q = u.searchParams.get("q") ?? "";
        const body = {
          hits: baseDir ? search(baseDir, q) : [],
          extended: isExtendedQuery(q.trim()),
        };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      // Internal link routing: serve a sibling/nested .md file relative
      // to the source file's directory. Root path serves the source.
      const requested = resolveRequestedFile(u.pathname);
      if (requested) {
        const currentRel = pathRelative(baseDir, requested);
        try {
          const md = readFileSync(requested, "utf8");
          return htmlResponse(md, currentRel);
        } catch {
          return htmlResponse(null, currentRel, 404);
        }
      }

      // Directory mode root: highlight the chosen index file (if any).
      const rootRel = opts.dirMode && opts.source
        ? pathRelative(baseDir, opts.source)
        : "";
      return htmlResponse(content, rootRel);
    },
    websocket: {
      open(ws) {
        sockets.add(ws as unknown as WebSocket);
      },
      message() {
        /* no-op */
      },
      close(ws) {
        sockets.delete(ws as unknown as WebSocket);
      },
    },
  });

  const fileLabel = opts.source ? ` ${opts.source}` : " (stdin)";
  const reloadLabel = opts.source ? " · live-reload on" : "";
  console.error(`mdrfc serving${fileLabel} at ${url}${reloadLabel}`);
  console.error(`press Ctrl-C to stop`);

  if (opts.open) openBrowser(url);

  // keep process alive
  process.on("SIGINT", () => {
    server.stop(true);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}
