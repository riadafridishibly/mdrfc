import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, type RenderOpts, type TocMode } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

const DOC = "# Title\n\n## First\n\n## Second\n";

/**
 * Placement is an inline script — the list has to be where it belongs before
 * the document paints. Pull it back out of the rendered page and run it
 * against happy-dom, which has no layout of its own, so every box it measures
 * is stubbed below.
 */
function placementSource(html: string): string {
  const found = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .filter((s) => s.includes("window.mdrfcToc = {"));
  expect(found.length).toBe(1);
  return found[0]!;
}

/** The script that settles the placement before the document paints. */
function bootSource(html: string): string {
  const found = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .filter((s) => s.includes("mdrfc.width"));
  expect(found.length).toBe(1);
  return found[0]!;
}

interface Box {
  left: number;
  right: number;
}

/** Give an element a fixed box, as a laid-out page would have. */
function box(el: Element, b: Box): void {
  (el as any).getBoundingClientRect = () => ({
    left: b.left,
    right: b.right,
    top: 0,
    bottom: 0,
    width: b.right - b.left,
    height: 0,
  });
}

/**
 * Lay the page out at `viewport` wide with the column at `main` — and the
 * filetree at `aside`, when there is one — then run the script over it.
 */
function run(viewport: number, main: Box, served: TocMode = "top", aside?: Box) {
  const html = renderWeb(DOC, { ...OPTS, toc: served });
  document.documentElement.setAttribute("data-toc", served);
  document.body.innerHTML = html.match(/<main>[\s\S]*?<\/main>/)![0]!;
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: viewport,
    configurable: true,
  });
  box(document.querySelector("main")!, main);
  if (aside) {
    const el = document.createElement("aside");
    el.id = "mdrfc-sidebar";
    document.body.appendChild(el);
    box(el, aside);
  }
  new Function(placementSource(html))();
}

const mode = () => document.documentElement.getAttribute("data-toc");
const placed = () => document.documentElement.classList.contains("mdrfc-toc-placed");
const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  GlobalRegistrator.register({ url: "http://localhost:2119/" });
  localStorage.clear();
});

afterEach(async () => {
  await GlobalRegistrator.unregister();
});

describe("table of contents placement", () => {
  test("puts the column beside the text, in the margin asked for", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    expect(mode()).toBe("right");
    expect(placed()).toBe(true);
    expect(cssVar("--toc-w")).toBe("300px"); // 500px of room, capped
    expect(cssVar("--toc-x")).toBe("1124px"); // 24px clear of the column
  });

  test("mirrors that on the other side", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1600, { left: 500, right: 1100 });
    expect(cssVar("--toc-x")).toBe("176px"); // 500 - 24 - 300
  });

  test("narrows the column to the room actually left", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 200, right: 750 });
    expect(mode()).toBe("right");
    expect(cssVar("--toc-w")).toBe("226px"); // 250 of room, less the 24 gap
  });

  test("falls back to the top when the margin is too thin to read", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 200, right: 850 });
    expect(mode()).toBe("top");
    expect(placed()).toBe(false);
  });

  test("keeps the preference through a fallback, and comes back to it", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 200, right: 850 });
    expect(mode()).toBe("top");
    // the window widens: the same preference now fits
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 1600,
      configurable: true,
    });
    box(document.querySelector("main")!, { left: 500, right: 1100 });
    window.dispatchEvent(new Event("resize"));
    expect(mode()).toBe("right");
  });

  test("the filetree's own column is not margin to spend", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1400, { left: 460, right: 1060 }, "top", { left: 0, right: 400 });
    expect(mode()).toBe("top"); // only 60px between the tree and the text
  });

  test("off leaves the list hidden wherever it would have gone", () => {
    localStorage.setItem("mdrfc.toc", "off");
    run(1600, { left: 500, right: 1100 });
    expect(mode()).toBe("off");
    expect(placed()).toBe(false);
  });

  test("the served default stands in when nothing is stored", () => {
    run(1600, { left: 500, right: 1100 }, "right");
    expect(mode()).toBe("right");
  });

  test("a placement chosen in settings applies without a reload", () => {
    run(1600, { left: 500, right: 1100 });
    expect(mode()).toBe("top");
    (window as any).mdrfcToc.apply("right");
    expect(mode()).toBe("right");
    expect(placed()).toBe(true);
  });
});

// Nothing is laid out yet here, so the window's own width stands in for the
// measurement. It has to cover the served placement as well as a stored one:
// a margin that only gives way after the first paint shoves the document down
// as it lands.
describe("placement before the first paint", () => {
  function boot(served: TocMode, wideEnough: boolean, stored?: TocMode) {
    const html = renderWeb(DOC, { ...OPTS, toc: served });
    document.documentElement.setAttribute("data-toc", served);
    if (stored) localStorage.setItem("mdrfc.toc", stored);
    (window as any).matchMedia = () => ({ matches: wideEnough });
    new Function(bootSource(html))();
    return mode();
  }

  test("a served margin waits for a window wide enough to hold it", () => {
    expect(boot("left", false)).toBe("top");
    expect(boot("left", true)).toBe("left");
  });

  test("a stored margin is held to the same test", () => {
    expect(boot("top", false, "right")).toBe("top");
    expect(boot("top", true, "right")).toBe("right");
  });

  test("a placement needing no margin is left as it is", () => {
    expect(boot("off", false)).toBe("off");
    expect(boot("top", false)).toBe("top");
  });
});

describe("section tracking", () => {
  /** Put each heading at `tops[i]` down the window and re-read the list. */
  function headingsAt(tops: number[]) {
    const heads = document.querySelectorAll("main h1, main h2");
    heads.forEach((h, i) => {
      (h as any).getBoundingClientRect = () => ({ top: tops[i], left: 0, right: 0 });
    });
    (window as any).mdrfcToc.refresh();
    const active = document.querySelector("#mdrfc-toc a.active");
    return active ? active.textContent : null;
  }

  test("lights the last heading to have passed the top of the window", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    expect(headingsAt([0, 400, 900])).toBe("Title");
    expect(headingsAt([-600, -200, 300])).toBe("First");
    expect(headingsAt([-1200, -800, -100])).toBe("Second");
  });

  test("lights the first entry before any heading has scrolled past", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    expect(headingsAt([300, 700, 1200])).toBe("Title");
  });

  test("lights nothing at all when the list is off", () => {
    localStorage.setItem("mdrfc.toc", "off");
    run(1600, { left: 500, right: 1100 });
    expect(headingsAt([-600, -200, 300])).toBe(null);
  });
});
