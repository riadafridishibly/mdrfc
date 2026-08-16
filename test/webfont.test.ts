import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import { listSystemFonts } from "../src/fonts.ts";
import {
  readWebfont,
  WEBFONT_FAMILY,
  WEBFONT_PATH,
  WEBFONT_PRELOAD,
} from "../src/webfont.ts";
import { RFC_WIDTH, VERSION } from "../src/util.ts";

const PAGE = renderWeb("# Doc", {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
});

describe("bundled webfont", () => {
  test("every declared face is on disk and is a woff2", () => {
    const urls = [...PAGE.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(4);
    const faces = urls.map((u) => {
      expect(u).toStartWith(WEBFONT_PATH);
      return u.slice(WEBFONT_PATH.length);
    });
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

  test("the faces are served under the running version, so an upgrade lands", () => {
    // Cached for a year; the URL is what has to change for a rebuilt face to
    // reach a reader who already has the old one.
    expect(WEBFONT_PATH).toBe(`/_font/${VERSION}/`);
    expect(WEBFONT_PRELOAD).toStartWith(WEBFONT_PATH);
  });

  test("the face swaps in rather than blocking the first paint", () => {
    expect([...PAGE.matchAll(/font-display: swap/g)].length).toBe(4);
  });

  test("the picker is offered the bundled family whether or not it is installed", () => {
    const bundled = listSystemFonts().filter((f) => f.bundled);
    expect(bundled.length).toBe(1);
    expect(bundled[0].name).toBe(WEBFONT_FAMILY);
    expect(bundled[0].mono).toBe(true);
  });
});

/** The head script that decides whether to ask for the regular face early. */
function preloadScript(): string {
  const scripts = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const src = scripts.map((m) => m[1]).find((s) => s.includes('l.rel = "preload"'));
  if (!src) throw new Error("preload script not found in rendered page");
  return src;
}

function preloaded(): string | null {
  document.head.innerHTML = "";
  new Function(preloadScript())();
  const link = document.head.querySelector('link[rel="preload"]');
  return link ? link.getAttribute("href") : null;
}

describe("preloading the bundled face", () => {
  beforeEach(() => {
    GlobalRegistrator.register();
  });

  afterEach(async () => {
    localStorage.clear();
    await GlobalRegistrator.unregister();
  });

  test("a page that paints in the bundled face asks for it up front", () => {
    expect(preloaded()).toBe(WEBFONT_PRELOAD);
  });

  test("saving the bundled family from the picker still preloads it", () => {
    localStorage.setItem("mdrfc.font", WEBFONT_FAMILY);
    expect(preloaded()).toBe(WEBFONT_PRELOAD);
  });

  test("a reader with a font of their own is not made to fetch it", () => {
    localStorage.setItem("mdrfc.font", "Menlo");
    expect(preloaded()).toBeNull();
  });
});
