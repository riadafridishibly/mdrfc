import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
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

/**
 * `maxY` stands in for a document not yet as tall as it will be: the browser
 * clamps a scroll past the bottom, so what the script asked for and where it
 * landed part company until the images arrive.
 */
let maxY = Infinity;

function run(url: string, height = Infinity) {
  scrolled = [];
  maxY = height;
  history.replaceState(null, "", url);
  (window as any).scrollTo = (_x: number, y: number) => {
    const landed = Math.min(y, maxY);
    scrolled.push(landed);
    Object.defineProperty(window, "scrollY", { value: landed, configurable: true });
  };
  new Function(SRC)();
}

/** The document grows, as images landing after the first paint grow it. */
const grow = (height: number) => (maxY = height);

const key = (path: string) => "mdrfc.scroll:" + path;

/** Write an entry as an earlier visit would have left it. */
function seed(path: string, y: number, t = 1) {
  localStorage.setItem(key(path), JSON.stringify({ y, t }));
}

/** The offset the script would restore for `path` on a later visit. */
function stored(path: string): number | null {
  const raw = localStorage.getItem(key(path));
  return raw === null ? null : JSON.parse(raw).y;
}

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  // A real origin: the script keys on location.pathname, which about:blank
  // (happy-dom's default) has none of.
  GlobalRegistrator.register({ url: "http://localhost:2119/" });
  localStorage.clear(); // now outlives a page, so it has to be cleared by hand
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

afterEach(async () => {
  await GlobalRegistrator.unregister();
});

describe("per-document scroll memory", () => {
  test("restores the position stored for this path", () => {
    seed("/guide/net.md", 820);
    run("/guide/net.md");
    expect(scrolled).toEqual([820]);
  });

  test("leaves a document with no stored position at the top", () => {
    seed("/other.md", 820);
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
    expect(stored("/a.md")).toBe(300);
    expect(stored("/b.md")).toBe(70);
  });

  test("a hash in the URL wins over the stored position", () => {
    seed("/guide/net.md", 820);
    run("/guide/net.md#timeouts");
    expect(scrolled).toEqual([]);
  });

  test("a search hit handed over by the palette wins too", () => {
    seed("/guide/net.md", 820);
    sessionStorage.setItem("mdrfc.pendingHit", '{"query":"socket"}');
    run("/guide/net.md");
    expect(scrolled).toEqual([]);
  });

  test("restore reports whether it moved, so callers can fall back", () => {
    seed("/a.md", 500);
    run("/a.md");
    const api = (window as any).mdrfcScroll;
    expect(api.restore("/a.md")).toBe(true);
    expect(api.restore("/unread.md")).toBe(false);
  });

  test("a late layout shift is corrected, a reader's own scroll is not", () => {
    seed("/a.md", 500);
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

  test("a landing clamped by a short document is corrected, not read as a scroll", () => {
    seed("/a.md", 900);
    run("/a.md", 100); // images still missing: the page ends at 100
    expect(scrolled).toEqual([100]);

    window.dispatchEvent(new Event("scroll")); // the clamp's own scroll event
    grow(2000);
    window.dispatchEvent(new Event("load"));
    expect(scrolled).toEqual([100, 900]);
  });

  test("a search hit still wins once the palette has taken its handoff", () => {
    seed("/a.md", 900);
    sessionStorage.setItem("mdrfc.pendingHit", '{"query":"socket"}');
    run("/a.md");
    expect(scrolled).toEqual([]);

    sessionStorage.removeItem("mdrfc.pendingHit"); // the palette, painting the hit
    window.dispatchEvent(new Event("load"));
    expect(scrolled).toEqual([]);
  });

  test("the position is saved when the tab goes away mid-frame", () => {
    run("/a.md");
    Object.defineProperty(window, "scrollY", { value: 640, configurable: true });
    window.dispatchEvent(new Event("pagehide"));
    expect(stored("/a.md")).toBe(640);
  });

  test("a position outlives the tab that recorded it", () => {
    run("/a.md");
    scrollTo(410);
    (window as any).mdrfcScroll.save();
    sessionStorage.clear(); // the browser, closing the tab

    run("/a.md");
    expect(scrolled).toEqual([410]);
  });

  test("the least recently read documents are dropped past the cap", () => {
    for (let i = 0; i < 205; i++) seed("/doc" + i + ".md", 100 + i, i);
    run("/doc204.md");

    expect(stored("/doc0.md")).toBe(null);
    expect(stored("/doc4.md")).toBe(null);
    expect(stored("/doc5.md")).toBe(105);
    expect(stored("/doc204.md")).toBe(304);
  });

  test("pruning leaves other mdrfc settings alone", () => {
    localStorage.setItem("mdrfc.width", "88");
    for (let i = 0; i < 205; i++) seed("/doc" + i + ".md", 100 + i, i);
    run("/doc204.md");
    expect(localStorage.getItem("mdrfc.width")).toBe("88");
  });
});
