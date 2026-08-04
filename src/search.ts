import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative as pathRelative, resolve as pathResolve } from "node:path";
import { Fzf, extendedMatch } from "fzf";
import { SKIP_DIRS, slugifyHeading } from "./util.ts";

export type HitKind = "file" | "heading" | "text";

export interface SearchHit {
  kind: HitKind;
  /** Path relative to the search base, POSIX-style. */
  path: string;
  /** Basename, for display. */
  name: string;
  /** 1-based source line; 0 for whole-file hits. */
  line: number;
  /** Display text: the path, heading text, or matching line. */
  text: string;
  /** Heading slug to scroll to. Text hits carry their nearest preceding heading. */
  anchor?: string;
  score: number;
  /** `[start, length]` match range inside `text`, for highlighting. */
  range?: [number, number];
  /** Matched character offsets inside `text` (fuzzy path hits). */
  indices?: number[];
}

const FILE_LIST_TTL_MS = 1500;
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILE_HITS = 8;
const MAX_HEADING_HITS = 12;
const MAX_TEXT_HITS = 40;
const TEXT_HITS_PER_FILE = 3;
const SNIPPET_MAX = 160;

interface Cached {
  mtimeMs: number;
  text: string;
}

const contentCache = new Map<string, Cached>();
const fileListCache = new Map<string, { at: number; files: string[] }>();

/** Every `.md` file under `base`, as absolute paths. Cached briefly so a burst
 *  of keystrokes doesn't re-walk the tree on every request. */
function listMdFiles(base: string): string[] {
  const hit = fileListCache.get(base);
  const now = Date.now();
  if (hit && now - hit.at < FILE_LIST_TTL_MS) return hit.files;

  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = pathResolve(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.name.toLowerCase().endsWith(".md")) {
        files.push(abs);
      }
    }
  };
  walk(base);
  fileListCache.set(base, { at: now, files });
  return files;
}

/** Read a file, reusing the cached text while its mtime is unchanged. */
function readCached(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (st.size > MAX_FILE_BYTES) return null;
    const hit = contentCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = readFileSync(abs, "utf8");
    contentCache.set(abs, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

/**
 * Strip the inline markdown that would not survive rendering, so a slug built
 * from source heading text matches the id emitted into the HTML.
 */
function stripInlineMd(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .trim();
}

interface Entry {
  abs: string;
  /** Path relative to the base, POSIX-style. */
  rel: string;
  name: string;
}

const positions = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);

/**
 * Score a single string against a query with fzf's algorithm.
 * The search path matches whole lists at once through `Fzf`; this is the
 * one-candidate form, used by tests and by callers holding a single string.
 */
export function fuzzyMatch(
  needle: string,
  haystack: string
): { score: number; indices: number[] } | null {
  const [hit] = new Fzf([haystack]).find(needle);
  return hit ? { score: hit.score, indices: positions(hit.positions) } : null;
}

/**
 * True when the query uses fzf's extended syntax — `^prefix`, `suffix$`,
 * `'exact`, `!negate`, `|`.
 */
export function isExtendedQuery(q: string): boolean {
  return q.split(/\s+/).some((t) => t === "|" || /^[\^!']/.test(t) || /\$$/.test(t));
}

/**
 * Rank paths with fzf. Ordering (score, then fzf's own tiebreakers) is kept
 * as returned rather than re-sorted.
 */
function matchPaths(entries: Entry[], q: string): SearchHit[] {
  let results;
  try {
    results = new Fzf(entries, {
      selector: (e: Entry) => e.rel,
      match: extendedMatch,
      limit: MAX_FILE_HITS,
    }).find(q);
  } catch {
    return []; // malformed extended query, e.g. a lone quote
  }
  return results.map((r) => ({
    kind: "file" as const,
    path: r.item.rel,
    name: r.item.name,
    line: 0,
    text: r.item.rel,
    score: r.score,
    indices: positions(r.positions),
  }));
}

/** Split a query into lowercase terms; every term must be present (AND). */
function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Position of the first term in `lineLower`, or -1 if any term is missing. */
function matchLine(lineLower: string, ts: string[]): { at: number; len: number } | null {
  let first = -1;
  let len = 0;
  for (const t of ts) {
    const at = lineLower.indexOf(t);
    if (at === -1) return null;
    if (first === -1 || at < first) {
      first = at;
      len = t.length;
    }
  }
  return first === -1 ? null : { at: first, len };
}

/** Trim a long line around the match so the snippet stays readable. */
function snippet(line: string, at: number, len: number): { text: string; range: [number, number] } {
  const trimmedStart = line.length - line.trimStart().length;
  let text = line.trim();
  let start = at - trimmedStart;
  if (text.length > SNIPPET_MAX) {
    const from = Math.max(0, start - 40);
    text = (from > 0 ? "…" : "") + text.slice(from, from + SNIPPET_MAX) + "…";
    start = start - from + (from > 0 ? 1 : 0);
  }
  return { text, range: [Math.max(0, start), len] };
}

/**
 * Search every `.md` file under `base` for `query`.
 * Returns filename (fuzzy), heading, and content-line hits, each capped so a
 * single large corpus cannot flood the palette.
 */
export function search(base: string, query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const entries: Entry[] = listMdFiles(base).map((abs) => ({
    abs,
    rel: pathRelative(base, abs).split(/[\\/]/).join("/"),
    name: basename(abs),
  }));

  const fileHits = matchPaths(entries, q);

  // Extended operators only mean anything against a path. Scanning line
  // content for the literal operator characters would just add noise, so an
  // extended query is treated as a path filter and nothing else.
  if (isExtendedQuery(q)) return fileHits;

  const ts = terms(q);
  const headingHits: SearchHit[] = [];
  const textHits: SearchHit[] = [];

  for (const { abs, rel, name } of entries) {
    const content = readCached(abs);
    if (!content) continue;

    const lines = content.split("\n");
    let fenced = false;
    let currentAnchor: string | undefined;
    const slugSeen = new Map<string, number>();
    let perFile = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }

      const h = !fenced && /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const raw = stripInlineMd(h[2]);
        const base_ = slugifyHeading(raw);
        const n = slugSeen.get(base_) ?? 0;
        slugSeen.set(base_, n + 1);
        currentAnchor = n === 0 ? base_ : `${base_}-${n}`;

        const m = matchLine(raw.toLowerCase(), ts);
        if (m && headingHits.length < MAX_HEADING_HITS * 4) {
          headingHits.push({
            kind: "heading",
            path: rel,
            name,
            line: i + 1,
            text: raw,
            anchor: currentAnchor,
            // Shallower headings rank higher; exact-prefix matches higher still.
            score: 60 - h[1].length * 4 + (m.at === 0 ? 10 : 0),
            range: [m.at, m.len],
          });
        }
        continue;
      }

      if (perFile >= TEXT_HITS_PER_FILE) continue;
      const m = matchLine(line.toLowerCase(), ts);
      if (!m) continue;
      const sn = snippet(line, m.at, m.len);
      textHits.push({
        kind: "text",
        path: rel,
        name,
        line: i + 1,
        text: sn.text,
        anchor: currentAnchor,
        score: 10 - perFile,
        range: sn.range,
      });
      perFile++;
    }
  }

  const byScore = (a: SearchHit, b: SearchHit) =>
    b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line;

  return [
    ...fileHits,
    ...headingHits.sort(byScore).slice(0, MAX_HEADING_HITS),
    ...textHits.sort(byScore).slice(0, MAX_TEXT_HITS),
  ];
}
