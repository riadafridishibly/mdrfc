import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH } from "../src/util.ts";

/**
 * The content-width control, driven as shipped: the markup and the inline
 * script come out of the rendered page rather than being restated here.
 */
const PAGE = renderWeb("# Doc\n\ntext\n", {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
});

/** The settings IIFE — the only inline script that wires up the panel. */
function panelScript(): string {
  const scripts = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const src = scripts.map((m) => m[1]).find((s) => s.includes("mdrfc-width-num"));
  if (!src) throw new Error("settings script not found in rendered page");
  return src;
}

/** The gear button and the settings panel, i.e. everything the script binds to. */
function panelMarkup(): string {
  const start = PAGE.indexOf('<button id="mdrfc-gear"');
  const end = PAGE.indexOf("<script", start);
  if (start < 0 || end < 0) throw new Error("settings panel not found in rendered page");
  return PAGE.slice(start, end);
}

let range: HTMLInputElement;
let num: HTMLInputElement;
/**
 * How many times the panel has asked for the placement to be worked out again.
 * The real one is in the placement script; here it only has to be countable.
 */
let relayouts: number;

const root = () => document.documentElement;
const contentW = () => root().style.getPropertyValue("--content-w");

function drag(cols: number) {
  range.value = String(cols);
  range.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeCols(cols: number) {
  num.value = String(cols);
  num.dispatchEvent(new Event("input", { bubbles: true }));
}

function mount() {
  document.body.innerHTML = panelMarkup();
  relayouts = 0;
  (window as any).mdrfcToc = {
    relayout() {
      relayouts++;
    },
  };
  new Function(panelScript())();
  range = document.getElementById("mdrfc-width") as HTMLInputElement;
  num = document.getElementById("mdrfc-width-num") as HTMLInputElement;
}

beforeEach(() => {
  GlobalRegistrator.register();
  mount();
});

afterEach(async () => {
  localStorage.clear();
  await GlobalRegistrator.unregister();
});

describe("content width", () => {
  test("the slider sets the column and remembers it", () => {
    drag(120);
    expect(contentW()).toBe("120ch");
    expect(num.value).toBe("120");
    expect(localStorage.getItem("mdrfc.width")).toBe("120");
  });

  /**
   * The placement pins the page box to the document's own width, so a column
   * asked to grow has nowhere to grow into until that box is worked out again.
   * A narrower one shrinks inside the box it already has and the observer
   * catches it — which is why widening was the half that stayed put until a
   * reload.
   */
  test("a wider column asks for the page box to be worked out again", () => {
    drag(120);
    expect(relayouts).toBe(1);
    drag(160);
    expect(relayouts).toBe(2);
  });

  test("so does a narrower one, and the typed field", () => {
    drag(50);
    expect(relayouts).toBe(1);
    typeCols(90);
    expect(contentW()).toBe("90ch");
    expect(relayouts).toBe(2);
  });

  test("landing back on the served width clears the override and re-places", () => {
    drag(120);
    drag(RFC_WIDTH);
    expect(contentW()).toBe("");
    expect(localStorage.getItem("mdrfc.width")).toBe(null);
    expect(relayouts).toBe(2);
  });

  test("the panel works on a page with no contents column to place", () => {
    delete (window as any).mdrfcToc;
    drag(120);
    expect(contentW()).toBe("120ch");
  });
});
