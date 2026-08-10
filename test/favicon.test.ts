import { describe, expect, test } from "bun:test";
import { renderWeb } from "../src/render/web.ts";
import { FAVICON_PATH, FAVICON_SVG } from "../src/favicon.ts";
import { RFC_WIDTH, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

describe("favicon", () => {
  test("every page links it as an SVG icon", () => {
    const html = renderWeb("# Doc\n", OPTS);
    expect(html).toContain(
      `<link rel="icon" type="image/svg+xml" href="${FAVICON_PATH}">`
    );
  });

  // The icon is rasterised by the browser with no page around it, so it must
  // not reach for anything the document supplies — a font, a stylesheet, a
  // colour variable — and must carry its own size.
  test("is self-contained", () => {
    expect(FAVICON_SVG).toStartWith("<svg");
    expect(FAVICON_SVG).toContain('viewBox="0 0 32 32"');
    expect(FAVICON_SVG).not.toContain("<text");
    expect(FAVICON_SVG).not.toContain("var(--");
    expect(FAVICON_SVG).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});
