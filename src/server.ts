import { createServer, type ServerResponse } from "node:http";
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
import { FAVICON_PATH, FAVICON_SVG } from "./favicon.ts";
import { readWebfont, WEBFONT_PATH, WEBFONT_ROOT } from "./webfont.ts";
import type { RenderOpts } from "./util.ts";

// The browser-side runtime, read off disk at startup instead of imported: these
// are modules for the page, not for us, and Node has no text-import attribute
// that would hand them over as strings.
const preactSrc = readFileSync(
  new URL(import.meta.resolve("htm/preact/standalone")),
  "utf8"
);
const paletteSrc = readFileSync(new URL("./client/palette.js", import.meta.url), "utf8");
const highlightSrc = readFileSync(new URL("./client/highlight.js", import.meta.url), "utf8");

export interface ServerOpts extends RenderOpts {
  content: string;
  source?: string; // file path (for live-reload watch). undefined = stdin
  baseDir?: string; // explicit base directory (directory mode). defaults to dirname(source)
  dirMode?: boolean; // serving a directory tree of markdown files
  port: number;
  open: boolean;
}

/** A tab holding a live-reload stream open, and the document it is showing. */
interface ReloadClient {
  res: ServerResponse;
  /** Path relative to baseDir, "/"-separated, as the watcher reports changes. */
  rel: string;
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
        node.children.push({ name: e.name, path: rel, dir: false, children: [] });
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

/** Percent-decode a URL path, leaving a malformed escape as written. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Start local HTTP server serving the rendered markdown.
 * Live-reload over server-sent events when a filesystem path is being served.
 */
export async function startServer(opts: ServerOpts): Promise<void> {
  const port = await findFreePort(opts.port);
  const url = `http://localhost:${port}`;

  const clients = new Set<ReloadClient>();

  // Base directory used to resolve internal (relative) markdown links.
  // Explicit baseDir wins (directory mode); otherwise derive from source file.
  // null = stdin (no filesystem context).
  const baseDir = opts.baseDir ?? (opts.source ? pathResolve(dirname(opts.source)) : null);
  const sourceFile = opts.source ? pathResolve(opts.source) : null;

  // Rebuilt whenever a .md file appears or disappears, so the sidebar lists
  // what is on disk now rather than what was there at startup.
  let tree = opts.dirMode && baseDir ? buildMdTree(baseDir) : null;

  /** Where a served file sits under baseDir, in the form the watcher reports. */
  const relOf = (abs: string): string =>
    baseDir ? pathRelative(baseDir, abs).split(sep).join("/") : "";

  const rootRel = sourceFile ? relOf(sourceFile) : "";

  /**
   * Resolve a request path to a markdown file under baseDir.
   * Returns null if not allowed (stdin mode, traversal, non-md).
   * Takes an already-decoded path; the root path is the source file's.
   */
  function resolveRequestedFile(pathname: string): string | null {
    if (!baseDir) return null;
    if (pathname === "/") return null; // root serves the source file
    // strip leading slash so it resolves relative to baseDir
    const abs = pathResolve(baseDir, pathname.replace(/^\/+/, ""));
    // path traversal guard: must stay inside baseDir
    const inside = pathRelative(baseDir, abs);
    if (inside.startsWith("..") || inside.includes(`..${sep}`)) return null;
    if (!abs.toLowerCase().endsWith(".md")) return null;
    return abs;
  }

  /**
   * The markdown behind `/`. Re-read per request rather than cached, so a
   * reload shows the file as it is now even if the watcher missed the write.
   */
  function rootMarkdown(): string {
    if (!sourceFile) return opts.content; // stdin: nothing to re-read
    try {
      return readFileSync(sourceFile, "utf8");
    } catch {
      return "";
    }
  }

  // ── live reload ────────────────────────────────────────────────────────
  // The directory is watched, not the file. An editor that saves by writing a
  // temp file and renaming it over the original replaces the inode, leaving a
  // file watch attached to something no longer on disk — dead after one save,
  // which is why reloads stopped arriving. Directory mode watches recursively,
  // so files added or deleted while the server runs reach the sidebar too.
  if (baseDir) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const touched = new Set<string>();

    const flush = (): void => {
      timer = null;
      const changed = new Set(touched);
      touched.clear();

      let structural = false;
      if (opts.dirMode && baseDir) {
        const next = buildMdTree(baseDir);
        structural = JSON.stringify(next) !== JSON.stringify(tree);
        tree = next;
      }

      for (const client of clients) {
        // A new or deleted file changes every page's sidebar, so every tab
        // has to come back for it; an edit only concerns whoever is reading it.
        if (structural || changed.has(client.rel)) client.res.write("data: reload\n\n");
      }
    };

    const onChange = (_event: string, name: string | Buffer | null): void => {
      const file = typeof name === "string" ? name : name?.toString();
      if (!file || !file.toLowerCase().endsWith(".md")) return;
      touched.add(file.split(sep).join("/"));
      // One save is several filesystem events; answer the last of them.
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 80);
    };

    try {
      watch(baseDir, { recursive: opts.dirMode === true }, onChange);
    } catch {
      // Recursive watching is not available everywhere; the source file alone
      // is worse but better than nothing.
      if (sourceFile) {
        try {
          watch(sourceFile, onChange);
        } catch {
          /* no live reload */
        }
      }
    }
  }

  /** Open a server-sent-events stream for one tab. */
  function openReloadStream(res: ServerResponse, want: string): void {
    const abs = want === "/" ? sourceFile : resolveRequestedFile(want);
    const client: ReloadClient = { res, rel: abs ? relOf(abs) : rootRel };
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    // An idle stream gets dropped by whatever sits in between; a comment line
    // is the cheapest thing that counts as traffic.
    const beat = setInterval(() => res.write(":\n\n"), 25_000);
    const drop = (): void => {
      clearInterval(beat);
      clients.delete(client);
    };
    res.on("close", drop);
    res.on("error", drop);
    clients.add(client);
  }

  function send(
    res: ServerResponse,
    status: number,
    type: string,
    body: string,
    extra: Record<string, string> = {}
  ): void {
    sendBytes(res, status, type, Buffer.from(body, "utf8"), extra);
  }

  function sendBytes(
    res: ServerResponse,
    status: number,
    type: string,
    buf: Buffer,
    extra: Record<string, string> = {}
  ): void {
    res.writeHead(status, {
      "content-type": type,
      "content-length": buf.byteLength,
      ...extra,
    });
    res.end(buf);
  }

  /** Render `md`, or a 404 page if null. Never cached: it changes underneath. */
  function sendHtml(
    res: ServerResponse,
    md: string | null,
    currentRel: string,
    status = 200
  ): void {
    const body = md ?? "# Not found\n\nNo such markdown file.\n";
    const html = renderWeb(body, opts, baseDir ? "1" : undefined, tree, currentRel);
    send(res, status, "text/html; charset=utf-8", html, { "cache-control": "no-store" });
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", url);

    // Live-reload stream. The tab names the document it is showing, so an edit
    // only reloads the tabs reading that file.
    if (u.pathname === "/_reload") {
      if (!baseDir) {
        send(res, 404, "text/plain; charset=utf-8", "no live reload for stdin");
        return;
      }
      openReloadStream(res, u.searchParams.get("path") ?? "/");
      return;
    }

    // Site icon. The `.ico` sibling is answered empty rather than left to
    // fall through: without it, a browser that ignores the SVG link would be
    // handed the whole document as its icon.
    if (u.pathname === FAVICON_PATH) {
      send(res, 200, "image/svg+xml; charset=utf-8", FAVICON_SVG, {
        "cache-control": "no-store",
      });
      return;
    }
    if (u.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    // The bundled typeface. Cached indefinitely, unlike everything else here:
    // the faces are three quarters of a megabyte and only change when mdrfc
    // itself is upgraded, which changes the URL they are served on. The names
    // are checked against the shipped list, not the disk.
    if (u.pathname.startsWith(WEBFONT_ROOT)) {
      const font = u.pathname.startsWith(WEBFONT_PATH)
        ? readWebfont(u.pathname.slice(WEBFONT_PATH.length))
        : null; // a face from a version that is no longer the one running
      if (font) {
        sendBytes(res, 200, "font/woff2", font, {
          "cache-control": "max-age=31536000, immutable",
        });
      } else {
        send(res, 404, "text/plain; charset=utf-8", "no such font");
      }
      return;
    }

    // Installed font families (monospace flagged) for the settings panel
    if (u.pathname === "/_fonts") {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(listSystemFonts()));
      return;
    }

    // Command palette runtime. Served as separate modules rather than inlined
    // so the ~13 KB bundle isn't re-sent with every in-place navigation —
    // that only refetches the document, so these are not requested again.
    // Never cached: a viewer that live-reloads must not keep serving a stale
    // script after the source it came from has changed underneath it.
    const clientModule =
      u.pathname === "/_preact.js"
        ? preactSrc
        : u.pathname === "/_palette.js"
          ? paletteSrc
          : u.pathname === "/_highlight.js"
            ? highlightSrc
            : null;
    if (clientModule !== null) {
      send(res, 200, "text/javascript; charset=utf-8", clientModule, {
        "cache-control": "no-store",
      });
      return;
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
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(body));
      return;
    }

    // Internal link routing: serve a sibling/nested .md file relative
    // to the source file's directory. Root path serves the source.
    const requested = resolveRequestedFile(safeDecode(u.pathname));
    if (requested) {
      const currentRel = relOf(requested);
      try {
        sendHtml(res, readFileSync(requested, "utf8"), currentRel);
      } catch {
        sendHtml(res, null, currentRel, 404);
      }
      return;
    }

    // Directory mode root: highlight the chosen index file (if any).
    sendHtml(res, rootMarkdown(), opts.dirMode ? rootRel : "");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const fileLabel = opts.source ? ` ${opts.source}` : " (stdin)";
  const reloadLabel = baseDir ? " · live-reload on" : "";
  // The banner goes to stderr so stdout stays pipe-clean. Written directly
  // rather than via console.error, which some runtimes paint red — this is
  // status, not an error.
  const color = process.stderr.isTTY;
  const green = color ? "\x1b[32m" : "";
  const dim = color ? "\x1b[2m" : "";
  const reset = color ? "\x1b[0m" : "";
  process.stderr.write(`${green}mdrfc serving${fileLabel} at ${url}${reloadLabel}${reset}\n`);
  process.stderr.write(`${dim}press Ctrl-C to stop${reset}\n`);

  if (opts.open) openBrowser(url);

  // keep process alive
  const stop = (): void => {
    for (const client of clients) client.res.end();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
