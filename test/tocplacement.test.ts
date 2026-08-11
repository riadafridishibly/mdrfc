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
 * The document's box: `b` is where it sits with no column reserved, and it
 * slides half of whatever is reserved the other way, which is what `margin: 0
 * auto` does with the space the placement takes out of the page.
 */
function centred(el: Element, b: Box): void {
  const pad = (name: string) =>
    parseFloat(document.documentElement.style.getPropertyValue(name)) || 0;
  (el as any).getBoundingClientRect = () => {
    const shift = (pad("--toc-pad-left") - pad("--toc-pad-right")) / 2;
    return {
      left: b.left + shift,
      right: b.right + shift,
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
  centred(document.querySelector("main")!, main);
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
    expect(cssVar("--toc-w")).toBe("300px"); // 500px of room, capped
    expect(cssVar("--toc-x")).toBe("962px"); // 24px clear of the column
  });

  test("centres the two of them together, not the text on its own", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    // 324px out of the page box: the 300px column and the 24px gap. The text
    // gives up half of it and keeps the other half of its old margin, so the
    // pair sits between margins of 338px — 500 less the 162 it moved.
    expect(cssVar("--toc-pad-right")).toBe("324px");
    const main = document.querySelector("main")!.getBoundingClientRect();
    expect(main.left).toBe(338);
    expect(1600 - (Number(cssVar("--toc-x").slice(0, -2)) + 300)).toBe(338);
  });

  test("a margin too thin on its own holds the column once both pay", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1300, { left: 190, right: 1110 });
    // 190px to the right of the text would not have held a 190px column and
    // its gap; the 190 sitting idle on the other side makes up the difference.
    expect(mode()).toBe("right");
    expect(cssVar("--toc-w")).toBe("300px");
    expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(28);
  });

  test("mirrors that on the other side", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1600, { left: 500, right: 1100 });
    expect(cssVar("--toc-pad-left")).toBe("324px");
    expect(cssVar("--toc-x")).toBe("338px"); // 662 - 24 - 300
  });

  test("narrows the column to the room actually left", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1000, { left: 160, right: 840 });
    expect(mode()).toBe("right");
    // 160 a side, less 12 to keep clear of the window, doubled: 296 for the
    // pair to share, and the gap comes out of that.
    expect(cssVar("--toc-w")).toBe("272px");
  });

  test("widens with the text size, so an entry holds the same words", () => {
    localStorage.setItem("mdrfc.toc", "right");
    document.documentElement.style.setProperty("--font-size", "28px");
    run(2500, { left: 600, right: 1800 });
    expect(cssVar("--toc-w")).toBe("600px"); // the cap, at twice the type
    expect(cssVar("--toc-x")).toBe("1524px"); // the gap doubles with it
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
    expect(cssVar("--toc-pad-right")).toBe("0px"); // and gives the room back
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
    centred(document.querySelector("main")!, { left: 500, right: 1100 });
    window.dispatchEvent(new Event("resize"));
    expect(mode()).toBe("right");
  });

  test("the filetree's own column is not margin to spend", () => {
    localStorage.setItem("mdrfc.toc", "left");
    run(1400, { left: 460, right: 1060 }, "top", 400);
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

  // Navigation swaps the document out; a placement run in the gap has nothing
  // to measure against, and must not leave the page box paying for a column
  // that is no longer anywhere.
  test("gives the reserved room back when there is no document to place by", () => {
    localStorage.setItem("mdrfc.toc", "right");
    run(1600, { left: 500, right: 1100 });
    expect(cssVar("--toc-pad-right")).toBe("324px");
    document.querySelector("main")!.remove();
    (window as any).mdrfcToc.apply("right");
    expect(cssVar("--toc-pad-right")).toBe("0px");
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
