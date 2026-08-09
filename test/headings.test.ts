import { describe, expect, test } from "bun:test";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

/** Every rendered heading, as `[level, id, inner html]`. */
function headings(md: string): Array<[number, string, string]> {
  const html = renderWeb(md, OPTS);
  const out: Array<[number, string, string]> = [];
  for (const m of html.matchAll(/<h([1-6]) id="([^"]*)">([\s\S]*?)<\/h\1>/g)) {
    out.push([Number(m[1]), m[2]!, m[3]!]);
  }
  return out;
}

describe("heading permalinks", () => {
  test("every heading carries an id and a handle linking to it", () => {
    const [h1, h2] = headings("# Semantics\n\n## Message Body\n");
    expect(h1![1]).toBe("semantics");
    expect(h1![2]).toContain('<a class="mdrfc-anchor" href="#semantics"');
    expect(h2![1]).toBe("message-body");
    expect(h2![2]).toContain('href="#message-body"');
  });

  test("handles follow the deduped id of a repeated heading", () => {
    const hs = headings("# Notes\n\n# Notes\n\n# Notes\n");
    expect(hs.map((h) => h[1])).toEqual(["notes", "notes-1", "notes-2"]);
    expect(hs[2]![2]).toContain('href="#notes-2"');
  });

  test("the handle adds no text of its own to the document", () => {
    const [h1] = headings("# Semantics\n");
    expect(h1![2].replace(/<[^>]+>/g, "")).toBe("Semantics");
  });

  test("a heading holding a link keeps it unnested and external-safe", () => {
    const [h1] = headings("# See [RFC 9110](https://example.com/rfc)\n");
    expect(h1![2]).toContain('target="_blank"');
    // The handle is a sibling of the link, not wrapped around it.
    expect(h1![2].indexOf('class="mdrfc-anchor"')).toBeGreaterThan(
      h1![2].indexOf("</a>")
    );
  });

  test("the handle is not rewritten as an external link", () => {
    const [h1] = headings("# Semantics\n");
    expect(h1![2]).not.toContain('href="#semantics" target=');
  });
});
