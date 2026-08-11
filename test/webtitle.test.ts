import { describe, expect, test } from "./harness.ts";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

/** The rendered page's <title>, still HTML-escaped. */
function title(
  md: string,
  extra: { source?: string } = {},
  currentRel?: string
): string {
  const html = renderWeb(md, { ...OPTS, ...extra }, undefined, null, currentRel);
  return html.match(/<title>([\s\S]*?)<\/title>/)![1]!;
}

describe("document title", () => {
  test("prefers the frontmatter title over the first heading", () => {
    expect(title("---\ntitle: RFC 9110\n---\n# Ignored\n")).toBe("RFC 9110");
  });

  test("falls back to the first heading", () => {
    expect(title("# Semantics\n\n# Later\n")).toBe("Semantics");
  });

  test("strips markup and unescapes the heading text", () => {
    expect(title("# Tea & `crumpets` <hr>\n")).toBe("Tea &amp; crumpets");
  });

  test("falls back to the served filename", () => {
    expect(title("plain text\n", {}, "docs/spec-v2.md")).toBe("spec-v2");
  });

  test("falls back to the source filename when serving the root", () => {
    expect(title("plain text\n", { source: "/tmp/notes/README.md" })).toBe("README");
  });

  test("names the tool when the document has no name at all", () => {
    expect(title("plain text\n")).toBe("mdrfc");
  });
});
