import { execSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Detect the fonts available on the host, flagging the monospace ones.
 *
 * Strategy:
 *  1. `fc-list : family spacing` — Linux, or macOS if Homebrew fontconfig is
 *     installed. Cheap and accurate; `spacing >= 100` (FC_MONO) is fixed pitch.
 *  2. Scan the OS font directories and parse each sfnt's `name` + `post`
 *     tables directly; `post.isFixedPitch` is the monospace flag.
 *     Handles .ttf / .otf / .ttc (incl. TrueType collections like SF Mono).
 *     Only the header, the table directory and those two tables are read —
 *     a few KB per font rather than the whole file, which on a typical macOS
 *     install is a few gigabytes of glyph data we have no use for.
 *  3. Always merge in a curated default list so the picker is never empty.
 *
 * Monospace is a hint, not a filter: RFC output wants fixed pitch, so those
 * sort first in the picker, but every installed family is offered.
 *
 * Result is cached for the process lifetime — fonts don't change mid-session.
 */

const MAX_NAME_BYTES = 256 * 1024; // `name` tables are KBs; cap a corrupt length
const MAX_TTC_FONTS = 256; // real collections hold a handful; cap a corrupt count

export interface SystemFont {
  name: string;
  mono: boolean;
}

let cache: SystemFont[] | null = null;

const DEFAULTS = [
  "Menlo",
  "Monaco",
  "SF Mono",
  "Courier New",
  "Consolas",
  "Liberation Mono",
  "DejaVu Sans Mono",
  "JetBrains Mono",
  "Fira Code",
  "IBM Plex Mono",
];

export function listSystemFonts(): SystemFont[] {
  if (cache) return cache;
  const out = new Map<string, boolean>();

  // 1. fontconfig — "Family One,Family Two:spacing=100", spacing absent when proportional
  try {
    const txt = execSync("fc-list : family spacing", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    for (const line of txt.split("\n")) {
      const colon = line.indexOf(":");
      const spacing = colon >= 0 ? parseInt(line.slice(colon + 1).replace(/^spacing=/, ""), 10) : NaN;
      for (const f of (colon >= 0 ? line.slice(0, colon) : line).split(",")) {
        addFamily(out, f.trim(), spacing >= 100);
      }
    }
  } catch {
    /* fontconfig absent or failed */
  }

  // 2. native sfnt scan
  for (const dir of fontDirs()) scanDir(dir, out);

  // 3. curated defaults
  for (const d of DEFAULTS) addFamily(out, d, true);

  cache = Array.from(out, ([name, mono]) => ({ name, mono })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return cache;
}

/** Record a family; monospace wins if any source reports fixed pitch. */
function addFamily(out: Map<string, boolean>, name: string, mono: boolean): void {
  // skip empty and Apple-internal dot-prefixed families (not CSS-addressable)
  if (!name || name.startsWith(".")) return;
  if (mono || !out.has(name)) out.set(name, mono);
}

function fontDirs(): string[] {
  const home = homedir();
  const p = platform();
  if (p === "darwin") {
    return [
      "/System/Library/Fonts",
      "/Library/Fonts",
      "/Network/Library/Fonts",
      join(home, "Library", "Fonts"),
    ];
  }
  if (p === "win32") {
    const list = ["C:\\Windows\\Fonts"];
    const local = process.env.LOCALAPPDATA;
    if (local) list.push(join(local, "Microsoft", "Windows", "Fonts"));
    return list;
  }
  // linux + others
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    join(home, ".fonts"),
    join(home, ".local", "share", "fonts"),
  ];
}

/** Recursively add every family found under `dir`. Exported for tests, which
 *  need a scan they can point at a fixture directory. */
export function scanDir(dir: string, out: Map<string, boolean>): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) scanDir(full, out);
    else if (e.isFile() && /\.(ttf|otf|ttc)$/i.test(e.name)) parseFontFile(full, out);
  }
}

function parseFontFile(path: string, out: Map<string, boolean>): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const head = readAt(fd, 0, 12);
    if (!head) return;
    if (tag(head, 0) !== "ttcf") {
      parseSfnt(fd, 0, out);
      return;
    }
    // TrueType Collection: header (tag, u32 version, u32 numFonts, u32[numFonts] offsets)
    const numFonts = Math.min(head.readUInt32BE(8), MAX_TTC_FONTS);
    const offsets = readAt(fd, 12, numFonts * 4);
    if (!offsets) return;
    for (let i = 0; i + 4 <= offsets.length; i += 4) parseSfnt(fd, offsets.readUInt32BE(i), out);
  } catch {
    // One malformed font is not worth losing the rest of the scan over.
  } finally {
    closeSync(fd);
  }
}

function parseSfnt(fd: number, base: number, out: Map<string, boolean>): void {
  const header = readAt(fd, base, 12);
  if (!header) return;
  const numTables = header.readUInt16BE(4);
  const dir = readAt(fd, base + 12, numTables * 16);
  if (!dir) return;

  let nameOff = -1;
  let nameLen = 0;
  let postOff = -1;
  for (let rec = 0; rec < dir.length; rec += 16) {
    const t = tag(dir, rec);
    if (t === "name") {
      nameOff = dir.readUInt32BE(rec + 8);
      nameLen = dir.readUInt32BE(rec + 12);
    } else if (t === "post") postOff = dir.readUInt32BE(rec + 8);
  }
  if (nameOff < 0) return;
  const name = readAt(fd, nameOff, Math.min(nameLen, MAX_NAME_BYTES));
  if (!name) return;
  const fam = readFamilyName(name);
  if (!fam) return;

  // post.isFixedPitch lives at offset 12 in the post table (after version[4]
  // italicAngle[4] underlinePos[2] underlineThick[2]); non-zero => fixed pitch.
  // A truncated post table just means "unknown", i.e. not monospace.
  const post = postOff >= 0 ? readAt(fd, postOff + 12, 4) : null;
  addFamily(out, fam, post !== null && post.readUInt32BE(0) !== 0);
}

/** Read `len` bytes at `off`; null unless the whole range was there. */
function readAt(fd: number, off: number, len: number): Buffer | null {
  if (len <= 0) return null;
  try {
    const buf = Buffer.allocUnsafe(len);
    return readSync(fd, buf, 0, len, off) === len ? buf : null;
  } catch {
    return null;
  }
}

/** Read nameID=1 (family) from a `name` table buffer; prefer Windows/Unicode. */
function readFamilyName(buf: Buffer): string | null {
  if (buf.length < 6) return null;
  const count = buf.readUInt16BE(2);
  const storage = buf.readUInt16BE(4);
  let best: { prio: number; str: string } | null = null;
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > buf.length) break;
    const nameID = buf.readUInt16BE(rec + 6);
    if (nameID !== 1) continue;
    const platformID = buf.readUInt16BE(rec);
    const prio = namePrio(platformID, buf.readUInt16BE(rec + 2));
    if (best && prio <= best.prio) continue;
    const abs = storage + buf.readUInt16BE(rec + 10);
    const end = abs + buf.readUInt16BE(rec + 8);
    if (end > buf.length) continue;
    const str =
      platformID === 1
        ? buf.toString("latin1", abs, end) // MacRoman ≈ latin1 for ASCII names
        : decodeUtf16BE(buf, abs, end);
    best = { prio, str };
  }
  return best ? best.str.trim() : null;
}

function decodeUtf16BE(buf: Buffer, off: number, end: number): string {
  let s = "";
  for (let i = off; i + 1 < end; i += 2) {
    s += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  }
  return s;
}

function namePrio(p: number, e: number): number {
  if (p === 3 && e === 1) return 5; // Windows UTF-16BE
  if (p === 0) return 4; // Unicode
  if (p === 3 && e === 10) return 3; // Windows UTF-32 (rare)
  if (p === 1 && e === 0) return 2; // Mac Roman
  return 1;
}

function tag(buf: Buffer, off: number): string {
  return buf.toString("latin1", off, off + 4);
}
