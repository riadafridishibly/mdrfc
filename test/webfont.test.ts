import { describe, expect, test } from "./harness.ts";
import { renderWeb } from "../src/render/web.ts";
import { listSystemFonts } from "../src/fonts.ts";
import { readWebfont, WEBFONT_FAMILY, WEBFONT_PRELOAD } from "../src/webfont.ts";
import { RFC_WIDTH } from "../src/util.ts";

const PAGE = renderWeb("# Doc", {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
});

describe("bundled webfont", () => {
  test("every declared face is on disk and is a woff2", () => {
    const faces = [...PAGE.matchAll(/url\("\/_font\/([^"]+)"\)/g)].map((m) => m[1]);
    expect(faces.length).toBe(4);
    for (const file of faces) {
      const buf = readWebfont(file);
      expect(buf).not.toBeNull();
      // woff2 files start with the `wOF2` signature
      expect(buf!.toString("latin1", 0, 4)).toBe("wOF2");
    }
  });

  test("only the shipped faces are readable", () => {
    expect(readWebfont("../../package.json")).toBeNull();
    expect(readWebfont("IosevkaBrick-Heavy.woff2")).toBeNull();
    expect(readWebfont("")).toBeNull();
  });

  test("the page sets the bundled family first, over the system stack", () => {
    const body = /body \{[\s\S]*?\}/.exec(PAGE)![0];
    expect(body).toContain(`font-family: "${WEBFONT_FAMILY}", ui-monospace`);
  });

  test("the regular face is preloaded, and swaps in rather than blocking", () => {
    expect(PAGE).toContain(`href="${WEBFONT_PRELOAD}" crossorigin`);
    expect([...PAGE.matchAll(/font-display: swap/g)].length).toBe(4);
  });

  test("the picker is offered the bundled family whether or not it is installed", () => {
    const bundled = listSystemFonts().filter((f) => f.bundled);
    expect(bundled.length).toBe(1);
    expect(bundled[0].name).toBe(WEBFONT_FAMILY);
    expect(bundled[0].mono).toBe(true);
  });
});
