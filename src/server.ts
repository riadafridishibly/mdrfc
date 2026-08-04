import { watch, readFileSync } from "node:fs";
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

      const html = renderWeb(content, opts, opts.source ? "1" : undefined);
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
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
