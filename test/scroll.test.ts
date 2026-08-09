import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

/**
 * The scroll memory is an inline script — it has to run before the document
 * paints, so it can't be a module fetched over the wire like the palette.
 * Pull it back out of the rendered page and run it against happy-dom, which
 * is as close to the real thing as this suite gets.
 */
function scrollSource(): string {
  const html = renderWeb("# Doc\n\ntext\n", OPTS);
  const found = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .filter((s) => s.includes("window.mdrfcScroll"));
  expect(found.length).toBe(1);
  return found[0]!;
}

const SRC = scrollSource();

/** Every position the script scrolled to, oldest first. */
let scrolled: number[];

function run(url: string) {
  scrolled = [];
  history.replaceState(null, "", url);
  (window as any).scrollTo = (_x: number, y: number) => {
    scrolled.push(y);
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  };
  new Function(SRC)();
}

/** What the script would restore for `path` on a later visit. */
const stored = (path: string) => sessionStorage.getItem("mdrfc.scroll:" + path);

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  // A real origin: the script keys on location.pathname, which about:blank
  // (happy-dom's default) has none of.
  GlobalRegistrator.register({ url: "http://localhost:2119/" });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

afterEach(async () => {
  await GlobalRegistrator.unregister();
});

describe("per-document scroll memory", () => {
  test("restores the position stored for this path", () => {
    sessionStorage.setItem("mdrfc.scroll:/guide/net.md", "820");
    run("/guide/net.md");
    expect(scrolled).toEqual([820]);
  });

  test("leaves a document with no stored position at the top", () => {
    sessionStorage.setItem("mdrfc.scroll:/other.md", "820");
    run("/guide/net.md");
    expect(scrolled).toEqual([]);
  });

  test("keeps each document's position apart", async () => {
    run("/a.md");
    scrollTo(300);
    (window as any).mdrfcScroll.save();
    history.replaceState(null, "", "/b.md");
    scrollTo(70);
    (window as any).mdrfcScroll.save();
    expect(stored("/a.md")).toBe("300");
    expect(stored("/b.md")).toBe("70");
  });

  test("a hash in the URL wins over the stored position", () => {
    sessionStorage.setItem("mdrfc.scroll:/guide/net.md", "820");
    run("/guide/net.md#timeouts");
    expect(scrolled).toEqual([]);
  });

  test("a search hit handed over by the palette wins too", () => {
    sessionStorage.setItem("mdrfc.scroll:/guide/net.md", "820");
    sessionStorage.setItem("mdrfc.pendingHit", '{"query":"socket"}');
    run("/guide/net.md");
    expect(scrolled).toEqual([]);
  });

  test("restore reports whether it moved, so callers can fall back", () => {
    sessionStorage.setItem("mdrfc.scroll:/a.md", "500");
    run("/a.md");
    const api = (window as any).mdrfcScroll;
    expect(api.restore("/a.md")).toBe(true);
    expect(api.restore("/unread.md")).toBe(false);
  });

  test("a late layout shift is corrected, a reader's own scroll is not", () => {
    sessionStorage.setItem("mdrfc.scroll:/a.md", "500");
    run("/a.md");
    expect(scrolled).toEqual([500]);

    // The restore itself must not read as the reader scrolling.
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("load"));
    expect(scrolled).toEqual([500, 500]);

    scrollTo(120);
    window.dispatchEvent(new Event("load"));
    expect(scrolled).toEqual([500, 500]);
  });

  test("the position is saved when the tab goes away mid-frame", () => {
    run("/a.md");
    Object.defineProperty(window, "scrollY", { value: 640, configurable: true });
    window.dispatchEvent(new Event("pagehide"));
    expect(stored("/a.md")).toBe("640");
  });
});
