import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Detect monospace fonts available on the host.
 *
 * Strategy:
 *  1. `fc-list :spacing=mono family` — Linux, or macOS if Homebrew fontconfig
 *     is installed. Cheap and accurate.
 *  2. Scan the OS font directories and parse each sfnt's `name` + `post`
 *     tables directly. Keep only fonts whose `post.isFixedPitch` is non-zero.
 *     Handles .ttf / .otf / .ttc (incl. TrueType collections like SF Mono).
 *  3. Always merge in a curated default list so the picker is never empty.
 *
 * Result is cached for the process lifetime — fonts don't change mid-session.
 */

const MAX_BYTES = 60 * 1024 * 1024; // skip pathological files (>60MB)

let cache: string[] | null = null;

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

export function listSystemFonts(): string[] {
  if (cache) return cache;
  const out = new Set<string>();

  // 1. fontconfig (monospace only)
  try {
    const txt = execSync("fc-list :spacing=mono family", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    for (const line of txt.split("\n")) {
      const colon = line.indexOf(":");
      const fams = colon >= 0 ? line.slice(colon + 1) : line;
      for (const f of fams.split(",")) {
        const t = f.trim();
        if (t) out.add(t);
      }
    }
  } catch {
    /* fontconfig absent or failed */
  }

  // 2. native sfnt scan
  for (const dir of fontDirs()) scanDir(dir, out);

  // 3. curated defaults
  for (const d of DEFAULTS) out.add(d);

  cache = Array.from(out)
    .filter((n) => n && !n.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
  return cache;
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

function scanDir(dir: string, out: Set<string>): void {
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

function parseFontFile(path: string, out: Set<string>): void {
  let buf: Buffer;
  try {
    if (statSync(path).size > MAX_BYTES) return;
    buf = readFileSync(path);
  } catch {
    return;
  }
  if (tag(buf, 0) === "ttcf") {
    // TrueType Collection: header (tag, u32 version, u32 numFonts, u32[numFonts] offsets)
    let n = 0;
    try {
      n = buf.readUInt32BE(8);
    } catch {
      return;
    }
    for (let i = 0; i < n; i++) {
      let off = 0;
      try {
        off = buf.readUInt32BE(12 + i * 4);
      } catch {
        break;
      }
      parseSfnt(buf, off, out);
    }
    return;
  }
  parseSfnt(buf, 0, out);
}

function parseSfnt(buf: Buffer, base: number, out: Set<string>): void {
  let numTables = 0;
  try {
    numTables = buf.readUInt16BE(base + 4);
  } catch {
    return;
  }
  let nameOff = -1;
  let postOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    let t = "";
    let toff = 0;
    try {
      t = tag(buf, rec);
      toff = buf.readUInt32BE(rec + 8);
    } catch {
      break;
    }
    if (t === "name") nameOff = toff;
    else if (t === "post") postOff = toff;
  }
  // Monospace gate: post.isFixedPitch lives at offset 12 in the post table
  // (after version[4] italicAngle[4] underlinePos[2] underlineThick[2]).
  // Non-zero => fixed pitch. Skip proportional fonts entirely.
  if (postOff >= 0) {
    try {
      if (buf.readUInt32BE(postOff + 12) === 0) return;
    } catch {
      /* post table too short; fall through and include */
    }
  }
  if (nameOff >= 0) {
    const fam = readFamilyName(buf, nameOff);
    // skip empty and Apple-internal dot-prefixed families (not CSS-addressable)
    if (fam && !fam.startsWith(".")) out.add(fam);
  }
}

/** Read nameID=1 (family) from the `name` table; prefer Windows/Unicode. */
function readFamilyName(buf: Buffer, off: number): string | null {
  let count = 0;
  let storage = 0;
  try {
    count = buf.readUInt16BE(off + 2);
    storage = off + buf.readUInt16BE(off + 4);
  } catch {
    return null;
  }
  let best: { prio: number; str: string } | null = null;
  for (let i = 0; i < count; i++) {
    const rec = off + 6 + i * 12;
    let platformID: number, encodingID: number, nameID: number;
    let length: number, strOff: number;
    try {
      platformID = buf.readUInt16BE(rec);
      encodingID = buf.readUInt16BE(rec + 2);
      nameID = buf.readUInt16BE(rec + 6);
      length = buf.readUInt16BE(rec + 8);
      strOff = buf.readUInt16BE(rec + 10);
    } catch {
      break;
    }
    if (nameID !== 1) continue;
    const prio = namePrio(platformID, encodingID);
    if (best && prio <= best.prio) continue;
    const abs = storage + strOff;
    const str =
      platformID === 1
        ? buf.toString("latin1", abs, abs + length) // MacRoman ≈ latin1 for ASCII names
        : decodeUtf16BE(buf, abs, length);
    best = { prio, str };
  }
  return best ? best.str.trim() : null;
}

function decodeUtf16BE(buf: Buffer, off: number, len: number): string {
  let s = "";
  const end = off + len;
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
