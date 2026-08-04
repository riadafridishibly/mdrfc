import { watch, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve, relative as pathRelative, sep } from "node:path";
import { renderWeb } from "./render/web.ts";
import { findFreePort } from "./util.ts";
import { openBrowser } from "./open.ts";
import type { RenderOpts } from "./util.ts";

export interface ServerOpts extends RenderOpts {
  content: string;
  source?: string; // file path (for live-reload watch). undefined = stdin
  port: number;
  open: boolean;
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
  // Only set when a source file was provided (stdin has no filesystem ctx).
  const baseDir = opts.source ? pathResolve(dirname(opts.source)) : null;

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
  function htmlResponse(md: string | null, status = 200): Response {
    const body = md ?? "# Not found\n\nNo such markdown file.\n";
    const html = renderWeb(body, opts, opts.source ? "1" : undefined);
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

      // Internal link routing: serve a sibling/nested .md file relative
      // to the source file's directory. Root path serves the source.
      const requested = resolveRequestedFile(u.pathname);
      if (requested) {
        try {
          const md = readFileSync(requested, "utf8");
          return htmlResponse(md);
        } catch {
          return htmlResponse(null, 404);
        }
      }

      return htmlResponse(content);
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
  console.error(`mdweb serving${fileLabel} at ${url}${reloadLabel}`);
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
