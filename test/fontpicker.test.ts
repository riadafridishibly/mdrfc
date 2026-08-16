import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
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

function key(name: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

async function enter() {
  key("Enter");
  await Promise.resolve();
}

/** Put the panel on a fresh page, with `/_fonts` answering `fonts`. */
async function mount(fonts: { name: string; mono: boolean; bundled?: boolean }[]) {
  globalThis.fetch = (async () => new Response(JSON.stringify(fonts))) as typeof fetch;
  document.body.innerHTML = pageStyle() + panelMarkup();
  new Function(panelScript())();

  document.getElementById("mdrfc-gear")!.dispatchEvent(new Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0)); // let the /_fonts fetch settle

  input = document.getElementById("mdrfc-font") as HTMLInputElement;
  list = document.getElementById("mdrfc-font-list") as HTMLElement;
}

beforeEach(async () => {
  GlobalRegistrator.register();
  await mount(FONTS);
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
    // The bundled family heads the stack but is absent from this fixture, and
    // the generics after it are skipped — SFMono-Regular is a PostScript name
    // no family list reports, so the first entry actually installed is SF Mono.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("SF Mono (system default)");
  });

  test("typing searches without changing the font", async () => {
    await type("Monaco");
    expect(rows()).toEqual(["Monaco"]);
    expect(document.body.style.fontFamily).toBe("");
    expect(localStorage.getItem("mdrfc.font")).toBeNull();
  });

  test("a family that is not installed still applies, on Enter", async () => {
    await type("Comic Sans MS");
    expect(list.querySelector(".font-empty")).not.toBeNull();
    expect(document.body.style.fontFamily).toBe(""); // still only a search
    await enter();
    expect(document.body.style.fontFamily).toContain("Comic Sans MS");
    expect(localStorage.getItem("mdrfc.font")).toBe("Comic Sans MS");
  });

  test("Enter with no highlighted row commits the query", async () => {
    await type("mon");
    expect(list.querySelector("li.active")).toBeNull();
    await enter();
    expect(input.value).toBe("mon");
    expect(localStorage.getItem("mdrfc.font")).toBe("mon");
  });

  test("an emptied field on Enter returns to the system default", async () => {
    await type("Monaco");
    await enter();
    await type("");
    await enter();
    expect(document.body.style.fontFamily).toBe("");
    expect(localStorage.getItem("mdrfc.font")).toBeNull();
  });

  test("abandoning a search restores the family in force", async () => {
    await type("Monaco");
    await enter();
    await type("Zapf");
    key("Escape");
    expect(input.value).toBe("Monaco");
    expect(document.body.style.fontFamily.startsWith("Monaco")).toBe(true);
  });

  test("clicking away abandons the search too", async () => {
    await type("Monaco");
    await enter();
    await type("Zapf");
    document.body.dispatchEvent(new Event("click", { bubbles: true }));
    expect(input.value).toBe("Monaco");
    expect(list.childElementCount).toBe(0);
  });

  test("arrow keys move the active row and Enter picks it", async () => {
    await type("mon");
    key("ArrowDown");
    key("ArrowDown");
    expect(list.querySelector("li.active .sample")!.textContent).toBe("SF Mono");
    await enter();
    expect(input.value).toBe("SF Mono");
    expect(localStorage.getItem("mdrfc.font")).toBe("SF Mono");
  });

  test("Escape closes the list but leaves the panel open", async () => {
    await type("mon");
    key("Escape");
    expect(list.childElementCount).toBe(0);
    expect(document.getElementById("mdrfc-panel")!.classList.contains("open")).toBe(true);
  });
});

describe("the bundled family in the picker", () => {
  const WITH_BUNDLED = [{ name: "Iosevka Brick", mono: true, bundled: true }, ...FONTS];

  test("is what an empty field falls back to, and says so", async () => {
    await mount(WITH_BUNDLED);
    expect(input.placeholder).toBe("Iosevka Brick (bundled default)");
  });

  test("is tagged apart from the installed monospace families", async () => {
    await mount(WITH_BUNDLED);
    await type("iosevka");
    const li = list.querySelector("li[role=option]")!;
    expect(li.querySelector(".sample")!.textContent).toBe("Iosevka Brick");
    expect(li.querySelector(".tag")!.textContent).toBe("bundled");
  });

  test("can be picked back after another family, like any row", async () => {
    await mount(WITH_BUNDLED);
    await type("Monaco");
    await enter();
    await type("iosevka");
    (list.querySelector("li[role=option]") as HTMLElement).dispatchEvent(
      new Event("click", { bubbles: true }),
    );
    expect(localStorage.getItem("mdrfc.font")).toBe("Iosevka Brick");
    // A family with a space in it keeps its quotes where Monaco does not.
    expect(/^"Iosevka Brick",/.test(document.body.style.fontFamily)).toBe(true);
  });
});
