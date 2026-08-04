import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH } from "../src/util.ts";

/**
 * Drive the settings panel's font picker exactly as shipped: the markup and
 * the inline script are pulled out of the rendered page rather than restated
 * here, so a change to either shows up as a failure.
 */
const PAGE = renderWeb("# Doc", {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
});

const FONTS = [
  { name: "Menlo", mono: true },
  { name: "Monaco", mono: true },
  { name: "SF Mono", mono: true },
  { name: "Helvetica", mono: false },
  { name: "Helvetica Neue", mono: false },
  { name: "Zapfino", mono: false },
];

/** The settings IIFE — the only inline script that wires up the picker. */
function panelScript(): string {
  const scripts = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const src = scripts.map((m) => m[1]).find((s) => s.includes("mdrfc-font-list"));
  if (!src) throw new Error("settings script not found in rendered page");
  return src;
}

/** The page's stylesheet, so the default font stack under test is the real one. */
function pageStyle(): string {
  const m = /<style>[\s\S]*?<\/style>/.exec(PAGE);
  if (!m) throw new Error("stylesheet not found in rendered page");
  return m[0];
}

/** The gear button and the settings panel, i.e. everything the script binds to. */
function panelMarkup(): string {
  const start = PAGE.indexOf('<button id="mdrfc-gear"');
  const end = PAGE.indexOf("<script", start);
  if (start < 0 || end < 0) throw new Error("settings panel not found in rendered page");
  return PAGE.slice(start, end);
}

let input: HTMLInputElement;
let list: HTMLElement;

function rows(): string[] {
  return [...list.querySelectorAll("li[role=option] .sample")].map((el) => el.textContent ?? "");
}

async function type(value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
}

beforeEach(async () => {
  GlobalRegistrator.register();
  globalThis.fetch = (async () => new Response(JSON.stringify(FONTS))) as typeof fetch;
  document.body.innerHTML = pageStyle() + panelMarkup();
  new Function(panelScript())();

  document.getElementById("mdrfc-gear")!.dispatchEvent(new Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0)); // let the /_fonts fetch settle

  input = document.getElementById("mdrfc-font") as HTMLInputElement;
  list = document.getElementById("mdrfc-font-list") as HTMLElement;
});

afterEach(async () => {
  localStorage.clear();
  await GlobalRegistrator.unregister();
});

describe("font picker", () => {
  test("offers every installed family, monospace first", async () => {
    input.dispatchEvent(new Event("focus", { bubbles: true }));
    expect(rows().slice(0, 3)).toEqual(["Menlo", "Monaco", "SF Mono"]);
    expect(rows()).toContain("Zapfino");
    expect(document.getElementById("mdrfc-font-count")!.textContent).toBe("(3 mono of 6)");
  });

  test("tags the monospace rows only", async () => {
    input.dispatchEvent(new Event("focus", { bubbles: true }));
    const tagged = [...list.querySelectorAll("li[role=option]")]
      .filter((li) => li.querySelector(".tag"))
      .map((li) => li.querySelector(".sample")!.textContent);
    expect(tagged).toEqual(["Menlo", "Monaco", "SF Mono"]);
  });

  test("ranks prefix above word start, and drops non-matches", async () => {
    await type("mon");
    expect(rows()).toEqual(["Monaco", "SF Mono"]);
  });

  test("search is case-insensitive", async () => {
    await type("ZAPF");
    expect(rows()).toEqual(["Zapfino"]);
  });

  test("picking a row applies and persists the family", async () => {
    await type("mona");
    (list.querySelector("li[role=option]") as HTMLElement).dispatchEvent(
      new Event("click", { bubbles: true }),
    );
    expect(input.value).toBe("Monaco");
    expect(localStorage.getItem("mdrfc.font")).toBe("Monaco");
    expect(document.body.style.fontFamily.startsWith("Monaco")).toBe(true);
    expect(list.childElementCount).toBe(0); // list closes after a pick
  });

  test("names the family an empty field falls back to", () => {
    // Stack is ui-monospace, SFMono-Regular, "SF Mono", … — the generic is
    // skipped and SFMono-Regular is a PostScript name no family list reports,
    // so the first entry actually installed is SF Mono.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("SF Mono (system default)");
  });

  test("the default is not claimed once a font is chosen", async () => {
    await type("Monaco");
    expect(input.value).toBe("Monaco");
    expect(document.body.style.fontFamily).toContain("Monaco");
  });

  test("a family that is not installed still applies as typed", async () => {
    await type("Comic Sans MS");
    expect(document.body.style.fontFamily).toContain("Comic Sans MS");
    expect(localStorage.getItem("mdrfc.font")).toBe("Comic Sans MS");
    expect(list.querySelector(".font-empty")).not.toBeNull();
  });

  test("arrow keys move the active row and Enter picks it", async () => {
    await type("mon");
    for (const key of ["ArrowDown", "ArrowDown"]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    expect(list.querySelector("li.active .sample")!.textContent).toBe("SF Mono");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(input.value).toBe("SF Mono");
  });

  test("Escape closes the list but leaves the panel open", async () => {
    await type("mon");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(list.childElementCount).toBe(0);
    expect(document.getElementById("mdrfc-panel")!.classList.contains("open")).toBe(true);
  });
});
