import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative as pathRelative, resolve as pathResolve } from "node:path";
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

/**
 * Greedy subsequence match, scoring contiguity and word-boundary starts.
 * Returns null when `needle` is not a subsequence of `haystack`.
 */
export function fuzzyMatch(
  needle: string,
  haystack: string
): { score: number; indices: number[] } | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return { score: 0, indices: [] };

  const indices: number[] = [];
  let score = 0;
  let hi = 0;
  let prev = -2;

  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === ch) {
        found = hi;
        break;
      }
      hi++;
    }
    if (found === -1) return null;

    score += 1;
    if (found === prev + 1) score += 8; // contiguous run
    const before = found > 0 ? h[found - 1] : "";
    if (found === 0 || before === "/" || before === "-" || before === "_" || before === ".") {
      score += 6; // start of a path or word segment
    }
    if (found > prev + 1) score -= Math.min(3, (found - prev - 1) * 0.2); // gap
    indices.push(found);
    prev = found;
    hi = found + 1;
  }
  return { score, indices };
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
  const ts = terms(q);
  const files = listMdFiles(base);

  const fileHits: SearchHit[] = [];
  const headingHits: SearchHit[] = [];
  const textHits: SearchHit[] = [];

  for (const abs of files) {
    const rel = pathRelative(base, abs).split(/[\\/]/).join("/");
    const name = basename(abs);

    const fz = fuzzyMatch(q.replace(/\s+/g, ""), rel);
    if (fz) {
      // Matching inside the basename beats matching in the directory prefix.
      const inName = fz.indices[0] >= rel.length - name.length;
      fileHits.push({
        kind: "file",
        path: rel,
        name,
        line: 0,
        text: rel,
        score: fz.score + (inName ? 12 : 0),
        indices: fz.indices,
      });
    }

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
    ...fileHits.sort(byScore).slice(0, MAX_FILE_HITS),
    ...headingHits.sort(byScore).slice(0, MAX_HEADING_HITS),
    ...textHits.sort(byScore).slice(0, MAX_TEXT_HITS),
  ];
}
