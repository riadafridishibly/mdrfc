import { describe, expect, test } from "./harness.ts";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, slugifyHeading, type RenderOpts } from "../src/util.ts";

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

/** The id rendered for a document's single heading. */
const idFor = (heading: string) => headings("# " + heading + "\n")[0]![1];

// GitHub's slugs, so a link written against a document rendered there lands
// on the same heading here.
describe("heading slugs", () => {
  test("dropped punctuation leaves the spaces around it behind", () => {
    expect(idFor("Appendix A — go-lua gotchas")).toBe("appendix-a--go-lua-gotchas");
    expect(idFor("Width / RFC style")).toBe("width--rfc-style");
  });

  test("punctuation with no space beside it just goes", () => {
    expect(idFor("Hello, World!")).toBe("hello-world");
    expect(idFor("What's a socket?")).toBe("whats-a-socket");
  });

  test("an escaped ampersand slugs as the character, not as `amp`", () => {
    expect(idFor("Tea & crumpets")).toBe("tea--crumpets");
  });

  test("letters outside ASCII survive", () => {
    expect(idFor("café: notes")).toBe("café-notes");
    expect(idFor("日本語 heading")).toBe("日本語-heading");
  });

  test("a combining mark survives with the letter it sits on", () => {
    // The same two headings as above, decomposed — which is what a macOS
    // filesystem and a good many editors hand over.
    expect(idFor("cafe\u0301: notes")).toBe("cafe\u0301-notes");
    expect(idFor("\u30D2\u3099 test")).toBe("\u30D2\u3099-test");
  });

  test("entities the author wrote slug as the characters they stand for", () => {
    expect(idFor("A &mdash; B")).toBe("a--b");
    expect(idFor("A &#8212; B")).toBe("a--b");
    expect(idFor("Tea &amp; crumpets")).toBe("tea--crumpets");
    expect(idFor("Caf&eacute; notes")).toBe("caf\u00E9-notes");
  });

  test("an image in a heading leaves nothing behind, as the page shows it", () => {
    expect(idFor("![logo](logo.png) Title")).toBe("title");
  });

  test("hyphens and underscores are left as they were written", () => {
    expect(idFor("snake_case & kebab-case")).toBe("snake_case--kebab-case");
  });

  test("a heading with nothing sluggable still gets an id", () => {
    expect(idFor("!!!")).toBe("section");
  });

  test("the search index agrees with the rendered id", () => {
    // search.ts slugs the markdown source; web.ts slugs marked's HTML. An
    // entity or an inline tag between them would part the two.
    for (const h of ["Appendix A — go-lua gotchas", "Tea & crumpets", "café: notes"]) {
      expect(slugifyHeading(h)).toBe(idFor(h));
    }
  });
});

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
