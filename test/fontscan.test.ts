import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDir } from "../src/fonts.ts";

/**
 * A minimal sfnt holding one `name` table (family "Fixture Mono") and one
 * `post` table whose isFixedPitch is `mono`. Enough for the scanner; not a
 * font any rasterizer would accept.
 */
function sfnt(family: string, mono: boolean): Buffer {
  const chars = Buffer.from(family, "utf16le").swap16(); // name strings are UTF-16BE
  const nameTable = Buffer.alloc(6 + 12 + chars.length);
  nameTable.writeUInt16BE(0, 0); // format
  nameTable.writeUInt16BE(1, 2); // count
  nameTable.writeUInt16BE(6 + 12, 4); // storage offset
  nameTable.writeUInt16BE(3, 6 + 0); // platformID: Windows
  nameTable.writeUInt16BE(1, 6 + 2); // encodingID: Unicode BMP
  nameTable.writeUInt16BE(0, 6 + 4); // languageID
  nameTable.writeUInt16BE(1, 6 + 6); // nameID: family
  nameTable.writeUInt16BE(chars.length, 6 + 8);
  nameTable.writeUInt16BE(0, 6 + 10); // string offset
  chars.copy(nameTable, 6 + 12);

  const postTable = Buffer.alloc(16);
  postTable.writeUInt32BE(mono ? 1 : 0, 12); // isFixedPitch

  const numTables = 2;
  const dirSize = 12 + numTables * 16;
  const header = Buffer.alloc(dirSize);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(numTables, 4);
  const record = (i: number, tag: string, off: number, len: number) => {
    const at = 12 + i * 16;
    header.write(tag, at, "latin1");
    header.writeUInt32BE(off, at + 8);
    header.writeUInt32BE(len, at + 12);
  };
  // Table records must be sorted by tag: "name" < "post".
  record(0, "name", dirSize, nameTable.length);
  record(1, "post", dirSize + nameTable.length, postTable.length);
  return Buffer.concat([header, nameTable, postTable]);
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mdrfc-fonts-"));
  writeFileSync(join(dir, "mono.ttf"), sfnt("Fixture Mono", true));
  writeFileSync(join(dir, "prop.otf"), sfnt("Fixture Sans", false));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const scan = (): Map<string, boolean> => {
  const out = new Map<string, boolean>();
  scanDir(dir, out);
  return out;
};

/** `ttcf`, u32 version, u32 numFonts — with nothing after it. */
const ttcHeader = (numFonts: number): Buffer => {
  const b = Buffer.alloc(12);
  b.write("ttcf", 0, "latin1");
  b.writeUInt32BE(0x00010000, 4);
  b.writeUInt32BE(numFonts, 8);
  return b;
};

describe("font scan", () => {
  test("reads family names and the monospace flag", () => {
    expect(scan()).toEqual(
      new Map([
        ["Fixture Mono", true],
        ["Fixture Sans", false],
      ])
    );
  });

  test("a corrupt collection count does not abort the scan", () => {
    const bad = join(dir, "corrupt.ttc");
    writeFileSync(bad, ttcHeader(0xffffffff));
    try {
      // Before the clamp this threw RangeError out of Buffer.allocUnsafe,
      // losing every family on the machine, not just this file's.
      expect(scan().get("Fixture Mono")).toBe(true);
    } finally {
      rmSync(bad, { force: true });
    }
  });

  test("a truncated font is skipped, not fatal", () => {
    const bad = join(dir, "truncated.ttf");
    writeFileSync(bad, Buffer.from([0x00, 0x01, 0x00]));
    try {
      expect(scan().size).toBe(2);
    } finally {
      rmSync(bad, { force: true });
    }
  });

  test("non-font files are ignored", () => {
    writeFileSync(join(dir, "notes.txt"), "not a font");
    expect(scan().size).toBe(2);
  });
});
