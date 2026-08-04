import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyMatch, search } from "../src/search.ts";
import { slugifyHeading } from "../src/util.ts";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "mdrfc-search-"));
  mkdirSync(join(dir, "guide"));
  writeFileSync(
    join(dir, "README.md"),
    "# Fixture\n\n## Troubleshooting\n\nCheck the socket timeout.\n"
  );
  writeFileSync(
    join(dir, "guide", "advanced-config.md"),
    [
      "# Advanced Config",
      "",
      "## Socket tuning",
      "",
      "Set the socket timeout to 30s.",
      "",
      "```sh",
      "# not a heading, this is fenced",
      "```",
      "",
      "## Retries",
      "",
      "Uses backoff.",
    ].join("\n")
  );
  return dir;
}

describe("fuzzyMatch", () => {
  test("matches a subsequence and reports offsets", () => {
    const r = fuzzyMatch("advcfg", "guide/advanced-config.md");
    expect(r).not.toBeNull();
    expect(r!.indices).toEqual([6, 7, 8, 15, 18, 20]);
  });

  test("rejects a non-subsequence", () => {
    expect(fuzzyMatch("zzz", "guide/advanced-config.md")).toBeNull();
  });

  test("contiguous runs outrank scattered ones", () => {
    const tight = fuzzyMatch("config", "config.md")!;
    const loose = fuzzyMatch("config", "c-o-n-f-i-g.md")!;
    expect(tight.score).toBeGreaterThan(loose.score);
  });

  // A greedy left-to-right scan takes the "c" in "advanced" and loses both the
  // contiguous run and the word-boundary bonus; fzf finds the whole word.
  test("prefers a whole word over an earlier stray character", () => {
    const r = fuzzyMatch("config", "guide/advanced-config.md")!;
    expect(r.indices).toEqual([15, 16, 17, 18, 19, 20]);
  });
});

describe("search", () => {
  const dir = fixture();

  test("empty query returns nothing", () => {
    expect(search(dir, "   ")).toEqual([]);
  });

  test("finds headings, content, and filenames", () => {
    const kinds = new Set(search(dir, "socket").map((h) => h.kind));
    expect(kinds.has("heading")).toBe(true);
    expect(kinds.has("text")).toBe(true);
  });

  test("headings outrank content lines", () => {
    const hits = search(dir, "socket");
    expect(hits[0].kind).toBe("heading");
    expect(hits[0].text).toBe("Socket tuning");
  });

  test("text hits carry the nearest preceding heading anchor", () => {
    const hit = search(dir, "30s").find((h) => h.kind === "text");
    expect(hit?.anchor).toBe("socket-tuning");
    expect(hit?.line).toBe(5);
  });

  test("anchors agree with the ids the renderer emits", () => {
    const hit = search(dir, "Socket tuning").find((h) => h.kind === "heading");
    expect(hit!.anchor).toBe(slugifyHeading("Socket tuning"));
  });

  test("comments inside fenced code are not treated as headings", () => {
    const hits = search(dir, "not a heading");
    expect(hits.every((h) => h.kind !== "heading")).toBe(true);
  });

  test("multi-term queries require every term on the line", () => {
    expect(search(dir, "socket timeout").some((h) => h.kind === "text")).toBe(true);
    expect(search(dir, "socket giraffe")).toEqual([]);
  });

  test("fuzzy filename match returns a file hit", () => {
    const hit = search(dir, "advcfg").find((h) => h.kind === "file");
    expect(hit?.path).toBe("guide/advanced-config.md");
  });

  test("extended syntax anchors a prefix", () => {
    expect(search(dir, "^guide").map((h) => h.path)).toEqual(["guide/advanced-config.md"]);
  });

  test("extended syntax anchors a suffix", () => {
    expect(search(dir, "config.md$").map((h) => h.path)).toEqual([
      "guide/advanced-config.md",
    ]);
  });

  test("an extended query filters paths only, skipping content", () => {
    // plain query reaches headings...
    expect(search(dir, "config").some((h) => h.kind === "heading")).toBe(true);
    // ...the exact-match form is a path filter, so it does not
    const ext = search(dir, "'config");
    expect(ext.length).toBeGreaterThan(0);
    expect(ext.every((h) => h.kind === "file")).toBe(true);
  });

  test("a malformed extended query does not throw", () => {
    expect(() => search(dir, "!")).not.toThrow();
    expect(() => search(dir, "'")).not.toThrow();
  });

  test("match ranges point at the matched substring", () => {
    const hit = search(dir, "timeout").find((h) => h.kind === "text")!;
    const [start, len] = hit.range!;
    expect(hit.text.slice(start, start + len).toLowerCase()).toBe("timeout");
  });
});
