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
 * The document's box: `b` is where the stylesheet leaves it, which is what it
 * is measured at, and once the placement has handed out a page box its left
 * edge is that box's own — the box is set to the document's width, so there is
 * nowhere else for `margin: 0 auto` to put it.
 */
function laid(el: Element, b: Box): void {
  (el as any).getBoundingClientRect = () => {
    const set = document.documentElement.style.getPropertyValue("--pad-left");
    const left = set ? parseFloat(set) : b.left;
    return {
      left,
      right: left + (b.right - b.left),
      top: 0,
      bottom: 0,
      width: b.right - b.left,
      height: 0,
    };
  };
}

/**
 * Lay the page out at `viewport` wide with the column at `main` — and the
 * filetree `sidebar` px across, when there is one — then run the script over
 * it. The tree is measured from the width it is set to rather than from its
 * box, which is what it is mid-slide, so that is what is given here.
 */
function run(viewport: number, main: Box, served: TocMode = "top", sidebar?: number) {
  const html = renderWeb(DOC, { ...OPTS, toc: served });
  document.documentElement.setAttribute("data-toc", served);
  document.body.innerHTML = html.match(/<main>[\s\S]*?<\/main>/)![0]!;
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: viewport,
    configurable: true,
  });
  laid(document.querySelector("main")!, main);
  if (sidebar !== undefined) {
    const el = document.createElement("aside");
    el.id = "mdrfc-sidebar";
    document.body.appendChild(el);
    document.documentElement.style.setProperty("--sidebar-w", sidebar + "px");
  }
  new Function(placementSource(html))();
}

/**
 * Hover `text`'s entry, having given it a box `wide` px across holding `full`
 * px of text — clipped when the text is the wider of the two.
 */
function clipped(text: string, wide: number, full: number) {
  const a = [...document.querySelectorAll("#mdrfc-toc a")].find(
    (el) => el.textContent === text
  )!;
  Object.defineProperty(a, "clientWidth", { value: wide, configurable: true });
  Object.defineProperty(a, "scrollWidth", { value: full, configurable: true });
  box(a, { left: 1124, right: 1124 + wide });
  return a as HTMLElement;
}

function hover(text: string, wide: number, full: number) {
  clipped(text, wide, full).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

/** The keyboard's way in: the entry takes focus, as tabbing to it would. */
function tab(text: string, wide: number, full: number) {
  const a = clipped(text, wide, full);
  a.focus();
  a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  return a;
}

const peek = () => document.getElementById("mdrfc-toc-peek")!;
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
    expect(cssVar("--toc-w")).toBe("240px"); // 500px of room, capped
    expect(cssVar("--toc-x")).toBe("1124px"); // 24px clear of the column
  });

  test("leaves the text in the middle, the list going in room already there", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    // The 500px margin holds the 240px column and its 24px gap with room to
    // spare, so the text is not asked for any of it and stays centred.
    expect(cssVar("--pad-left")).toBe("500px");
    expect(cssVar("--pad-right")).toBe("500px");
    expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(500);
  });

  test("puts it in the other margin without moving the text", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1600, { left: 500, right: 1100 });
    expect(cssVar("--pad-left")).toBe("500px");
    expect(cssVar("--toc-x")).toBe("236px"); // 500 - 24 - 240
  });

  test("and leaves it there when the filetree opens beside it", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1600, { left: 500, right: 1100 }, "top", 248);
    // The tree eats into the left margin rather than pushing the text: 248px
    // of it gone still leaves room for a column, narrower by what it took.
    expect(cssVar("--pad-left")).toBe("500px");
    expect(cssVar("--toc-w")).toBe("216px");
    expect(cssVar("--toc-x")).toBe("260px"); // 500 - 24 - 216
  });

  test("a margin too thin on its own holds the column once both pay", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1300, { left: 190, right: 1110 });
    // 190px to the right of the text would not have held a 190px column and
    // its gap; the 190 sitting idle on the other side makes up the difference.
    expect(mode()).toBe("right");
    expect(cssVar("--toc-w")).toBe("240px");
    // 240 and a 24px gap, 12px clear of the window: the text gives up 86px.
    expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(104);
    expect(cssVar("--toc-x")).toBe("1048px");
  });

  test("narrows the column to the room actually left", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 140, right: 860 });
    expect(mode()).toBe("right");
    // 140 a side, less 12 to keep clear of the window, doubled: 256 for the
    // pair to share, and the gap comes out of that.
    expect(cssVar("--toc-w")).toBe("232px");
  });

  test("widens with the text size, so an entry holds the same words", () => {
    localStorage.setItem("mdrfc.toc", "right");
    document.documentElement.style.setProperty("--font-size", "28px");
    run(2500, { left: 600, right: 1800 });
    expect(cssVar("--toc-w")).toBe("480px"); // the cap, at twice the type
    expect(cssVar("--toc-x")).toBe("1898px"); // the gap doubles with it
  });

  test("and gives way sooner, a margin being thinner in larger type", () => {
    localStorage.setItem("mdrfc.toc", "right");
    document.documentElement.style.setProperty("--font-size", "28px");
    run(1500, { left: 200, right: 1300 });
    expect(mode()).toBe("top"); // 400px between them: fine at 14px, not at 28
  });

  test("falls back to the top when the margin is too thin to read", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 100, right: 880 });
    expect(mode()).toBe("top");
    expect(placed()).toBe(false);
    // and the text keeps the middle, nothing having been taken out for a list
    expect(cssVar("--pad-left")).toBe("110px");
    expect(cssVar("--pad-right")).toBe("110px");
  });

  test("keeps the preference through a fallback, and comes back to it", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 100, right: 880 });
    expect(mode()).toBe("top");
    // the window widens: the same preference now fits
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 1600,
      configurable: true,
    });
    laid(document.querySelector("main")!, { left: 500, right: 1100 });
    window.dispatchEvent(new Event("resize"));
    expect(mode()).toBe("right");
  });

  test("the filetree's own column is not margin to spend", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1200, { left: 416, right: 1016 }, "top", 400);
    expect(mode()).toBe("top"); // 176px left over once the tree has its 400
  });

  test("a tree crowding the margin asked for moves the text, not the list", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1400, { left: 416, right: 1016 }, "top", 400);
    // Centred, the text would sit 16px off the tree — no margin at all to put
    // a list in. It gives up the middle for as much as the column needs.
    expect(mode()).toBe("left");
    expect(cssVar("--toc-x")).toBe("412px"); // the tree's 400, and 12 clear
    expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(676);
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

  // Navigation swaps the document out; a placement run in the gap has nothing
  // to measure against, and must not leave a page box behind for a document
  // that is no longer anywhere.
  test("gives the page box back when there is no document to place by", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    expect(cssVar("--pad-right")).toBe("500px");
    document.querySelector("main")!.remove();
    (window as any).mdrfcToc.apply("right");
    expect(cssVar("--pad-right")).toBe("");
    expect(placed()).toBe(false);
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

  // The margin is measured and revealed by script. The stylesheet keeps the
  // list in the flow until this says there is one, so a page served `left`
  // with scripts off reads its contents at the top rather than nowhere.
  test("marks the page as one a script is placing", () => {
    expect(document.documentElement.classList.contains("mdrfc-js")).toBe(false);
    boot("left", true);
    expect(document.documentElement.classList.contains("mdrfc-js")).toBe(true);
  });
});

describe("reading a clipped entry", () => {
  beforeEach(() => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
  });

  test("hovering one whose text was cut lays the whole of it over the page", () => {
    hover("First", 200, 420);
    expect(peek().style.display).toBe("block");
    expect(peek().textContent).toBe("First");
    expect(peek().style.left).toBe("1124px"); // where the entry itself starts
    expect(peek().style.top).toBe("0px");
  });

  test("hovering one that already fits shows nothing", () => {
    hover("First", 200, 200);
    expect(peek().style.display).toBe("none");
  });

  test("leaving the list takes it away again", () => {
    hover("First", 200, 420);
    document.querySelector("main")!.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true })
    );
    expect(peek().style.display).toBe("none");
  });

  test("scrolling the column takes it away, the entry having moved", () => {
    hover("First", 200, 420);
    document.getElementById("mdrfc-toc")!.dispatchEvent(new Event("scroll"));
    expect(peek().style.display).toBe("none");
  });

  // Tabbing to an entry below the fold scrolls the column as part of focusing
  // it, so the scroll that would take the layer away is the same event that
  // brought the entry into view.
  test("an entry tabbed to keeps it through the scroll that revealed it", () => {
    tab("First", 200, 420);
    expect(peek().style.display).toBe("block");
    document.getElementById("mdrfc-toc")!.dispatchEvent(new Event("scroll"));
    expect(peek().style.display).toBe("block");
    expect(peek().textContent).toBe("First");
  });

  test("and loses it once the focus moves on", () => {
    tab("First", 200, 420);
    (document.querySelector("main") as HTMLElement).focus();
    document.getElementById("mdrfc-toc")!.dispatchEvent(new Event("scroll"));
    expect(peek().style.display).toBe("none");
  });

  test("it is not read out twice: the entry itself is the one announced", () => {
    expect(peek().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a clipped entry with the filetree open", () => {
  test("is pulled back over the document, and stops at the tree", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 }, "top", 400);
    // Wider than the window: pulling its tail in would put its head over the
    // tree, which is not the document's space to lay anything over.
    Object.defineProperty(peek(), "offsetWidth", { value: 1500, configurable: true });
    hover("First", 200, 420);
    expect(peek().style.left).toBe("412px"); // the tree's 400, and 12 clear of it
    expect(peek().style.maxWidth).toBe("1176px"); // the room that leaves
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
