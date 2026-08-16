import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import { ANNOUNCEMENTS } from "../src/announce.ts";
import { WEBFONT_FAMILY } from "../src/webfont.ts";
import { RFC_WIDTH } from "../src/util.ts";

/**
 * The notice as shipped: markup and script are pulled out of the rendered page
 * rather than restated here, and the announcement under test is the one that
 * actually ships, so retiring it fails these instead of passing them silently.
 */
const PAGE = renderWeb("# Doc", {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
});

const FONT_NOTICE = ANNOUNCEMENTS.find((a) => a.action === "use-bundled-font")!;
const KEY = `mdrfc.ann.${FONT_NOTICE.id}`;

const FONTS = [
  { name: "Menlo", mono: true },
  { name: WEBFONT_FAMILY, mono: true, bundled: true },
];

function panelScript(): string {
  const scripts = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const src = scripts.map((m) => m[1]).find((s) => s.includes("mdrfc-font-list"));
  if (!src) throw new Error("settings script not found in rendered page");
  return src;
}

/** The gear, the panel and the notice container — everything the script binds to. */
function panelMarkup(): string {
  const start = PAGE.indexOf('<button id="mdrfc-gear"');
  const end = PAGE.indexOf("<script", start);
  if (start < 0 || end < 0) throw new Error("settings panel not found in rendered page");
  return PAGE.slice(start, end);
}

let notice: HTMLElement;

/** Run the page script against current storage, as a fresh page load would. */
async function load() {
  globalThis.fetch = (async () => new Response(JSON.stringify(FONTS))) as typeof fetch;
  document.body.innerHTML = panelMarkup();
  new Function(panelScript())();
  await Promise.resolve();
  notice = document.getElementById("mdrfc-notice") as HTMLElement;
}

function button(label: string): HTMLButtonElement {
  const found = [...notice.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button in the notice`);
  return found as HTMLButtonElement;
}

function click(el: HTMLElement) {
  el.dispatchEvent(new Event("click", { bubbles: true }));
}

beforeEach(() => {
  GlobalRegistrator.register();
});

afterEach(async () => {
  localStorage.clear();
  await GlobalRegistrator.unregister();
});

describe("announcements", () => {
  test("nothing is announced to a reader the notice does not apply to", async () => {
    await load(); // no saved font: the bundled family is already what they read
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe("");
  });

  test("nothing is announced to a reader who already picked the bundled family", async () => {
    // Saved like any other family, but it is the font the notice would offer.
    localStorage.setItem("mdrfc.font", WEBFONT_FAMILY);
    await load();
    expect(notice.hidden).toBe(true);
    expect(localStorage.getItem("mdrfc.font")).toBe(WEBFONT_FAMILY);
  });

  test("a reader with a font of their own is offered the new one", async () => {
    localStorage.setItem("mdrfc.font", "Menlo");
    await load();
    expect(notice.hidden).toBe(false);
    expect(notice.querySelector("h3")!.textContent).toBe(FONT_NOTICE.title);
    expect(notice.querySelector("p")!.textContent).toBe(FONT_NOTICE.body);
    // Offered, not taken: the saved font is still in force behind the notice.
    expect(localStorage.getItem("mdrfc.font")).toBe("Menlo");
    expect(document.body.style.fontFamily).toStartWith("Menlo");
  });

  test("accepting drops the saved font, landing on the bundled family", async () => {
    localStorage.setItem("mdrfc.font", "Menlo");
    await load();
    click(button(FONT_NOTICE.accept));
    expect(localStorage.getItem("mdrfc.font")).toBeNull();
    expect(document.body.style.fontFamily).toBe(""); // i.e. the stylesheet's stack
    expect((document.getElementById("mdrfc-font") as HTMLInputElement).value).toBe("");
    expect(notice.hidden).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("y");
  });

  test("dismissing keeps the reader's font exactly as it was", async () => {
    localStorage.setItem("mdrfc.font", "Menlo");
    await load();
    click(button(FONT_NOTICE.dismiss));
    expect(localStorage.getItem("mdrfc.font")).toBe("Menlo");
    expect(notice.hidden).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("n");
  });

  test("closing it counts as dismissing it", async () => {
    localStorage.setItem("mdrfc.font", "Menlo");
    await load();
    click(notice.querySelector("button.close") as HTMLElement);
    expect(localStorage.getItem("mdrfc.font")).toBe("Menlo");
    expect(localStorage.getItem(KEY)).toBe("n");
  });

  test("an answered notice never comes back, either way it was answered", async () => {
    for (const answer of [FONT_NOTICE.accept, FONT_NOTICE.dismiss]) {
      localStorage.clear();
      localStorage.setItem("mdrfc.font", "Menlo");
      await load();
      click(button(answer));

      localStorage.setItem("mdrfc.font", "Menlo"); // and still overridden
      await load();
      expect(notice.hidden).toBe(true);
    }
  });

  test("the notice is announced once, not once per page", async () => {
    localStorage.setItem("mdrfc.font", "Menlo");
    await load();
    await load(); // an in-place navigation, with the question still unanswered
    expect(notice.hidden).toBe(false);
    expect(notice.querySelectorAll("h3")).toHaveLength(1);
  });
});
