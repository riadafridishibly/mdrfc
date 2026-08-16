import { describe, expect, test } from "./harness.ts";
import { renderWeb } from "../src/render/web.ts";
import { DEFAULT_TOC, RFC_WIDTH, type RenderOpts, type TocMode } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

function page(md: string, toc?: TocMode): string {
  return renderWeb(md, toc ? { ...OPTS, toc } : OPTS);
}

/** The contents list, or "" when the document was given none. */
function nav(md: string): string {
  return page(md).match(/<nav id="mdrfc-toc"[\s\S]*?<\/nav>/)?.[0] ?? "";
}

/** Every entry as [indent level, href, text]. */
function entries(md: string): Array<[number, string, string]> {
  return [...nav(md).matchAll(/<li class="lvl-(\d)"><a href="#([^"]*)">([\s\S]*?)<\/a><\/li>/g)].map(
    (m) => [Number(m[1]), m[2]!, m[3]!]
  );
}

const DOC = `# Title

intro

## First

## Second

### Nested
`;

describe("table of contents", () => {
  test("lists every heading in document order", () => {
    expect(entries(DOC).map((e) => e[2])).toEqual([
      "Title",
      "First",
      "Second",
      "Nested",
    ]);
  });

  test("links to the ids the body's own headings carry", () => {
    const html = page(DOC);
    expect(entries(DOC).map((e) => e[1])).toEqual(["title", "first", "second", "nested"]);
    for (const [level, id] of entries(DOC)) {
      expect(html).toContain(`<h${level === 0 ? 1 : level + 1} id="${id}">`);
    }
  });

  test("indents relative to the shallowest heading present", () => {
    expect(entries(DOC).map((e) => e[0])).toEqual([0, 1, 1, 2]);
    // the same sections without an h1 above them start at the left edge
    expect(entries("## First\n\n### Nested\n").map((e) => e[0])).toEqual([0, 1]);
  });

  test("clamps indentation so a deep tail stays readable", () => {
    const deep = "# A\n\n###### B\n";
    expect(entries(deep).map((e) => e[0])).toEqual([0, 3]);
  });

  test("drops inline markup but keeps the text escaped", () => {
    expect(entries("# Tea & `crumpets`\n\n## Scones\n")[0]![2]).toBe("Tea &amp; crumpets");
  });

  test("omits the list when there is at most one heading", () => {
    expect(nav("# Alone\n\ntext\n")).toBe("");
    expect(nav("no headings at all\n")).toBe("");
  });

  test("sits between the frontmatter block and the document", () => {
    const html = page("---\ntitle: Spec\n---\n\n# One\n\n## Two\n");
    const fm = html.indexOf('<dl class="mdrfc-fm">');
    const toc = html.indexOf('<nav id="mdrfc-toc"');
    const body = html.indexOf('<h1 id="one">');
    expect(fm).toBeGreaterThan(-1);
    expect(toc).toBeGreaterThan(fm);
    expect(body).toBeGreaterThan(toc);
  });

  test("carries the placement into the document element", () => {
    expect(page(DOC, "left")).toContain('data-toc="left"');
    expect(page(DOC)).toContain(`data-toc="${DEFAULT_TOC}"`); // the served default
  });

  test("ships the list even when placement is off, so settings can show it", () => {
    const html = page(DOC, "off");
    expect(html).toContain('data-toc="off"');
    expect(html).toContain('<nav id="mdrfc-toc"');
  });
});
