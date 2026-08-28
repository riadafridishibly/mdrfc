import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb } from "../src/render/web.ts";
import {
  MERMAID_FILE,
  MERMAID_INIT_URL,
  MERMAID_URL,
  readMermaidBundle,
} from "../src/mermaid.ts";
import { RFC_WIDTH, VERSION, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

const OUT = "mdrfc-mermaid-out";
const SOURCE = 'graph TD\n  A[Start] --> B{"Choice & co"}';
const DOC = `# Doc\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n`;
const PAGE = renderWeb(DOC, OPTS);

/** The one diagram container in `html`. */
function box(html: string): string {
  const at = html.indexOf('<div class="mdrfc-code mdrfc-mermaid">');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</div></div>", at) + 12);
}

describe("a mermaid fence in the served markup", () => {
  test("becomes a diagram container, not a code block", () => {
    expect([...PAGE.matchAll(/class="mdrfc-code mdrfc-mermaid"/g)]).toHaveLength(1);
    expect(box(PAGE)).toContain('<div class="mdrfc-mermaid-out"');
  });

  test("carries its source, escaped, so the fallback is the markdown itself", () => {
    // What the reader sees with no JavaScript, no bundle, or a broken diagram.
    expect(box(PAGE)).toContain(
      '<pre data-mdrfc-mermaid><code class="language-mermaid">' +
        'graph TD\n  A[Start] --&gt; B{&quot;Choice &amp; co&quot;}'
    );
  });

  test("offers open, source and copy, and not the wrap a drawing cannot use", () => {
    const tools = box(PAGE);
    expect(tools).toContain('data-act="open"');
    expect(tools).toContain('data-act="source"');
    expect(tools).toContain('data-act="copy"');
    expect(tools).not.toContain('data-act="wrap"');
  });

  test("leaves every other fence to marked and the ordinary code tools", () => {
    expect(PAGE).toContain('<div class="mdrfc-code"><div class="mdrfc-code-tools"');
    expect(PAGE).toContain('<code class="language-js">');
    expect([...PAGE.matchAll(/data-act="wrap"/g)]).toHaveLength(1);
  });

  test("an info string after the language still reads as mermaid", () => {
    const page = renderWeb("```MERMAID  \ngraph TD\n  A-->B\n```\n", OPTS);
    expect(page).toContain('class="mdrfc-code mdrfc-mermaid"');
  });
});

describe("what the page asks the browser to fetch", () => {
  test("a document with a diagram loads the init module", () => {
    expect(PAGE).toContain(`<script type="module" src="${MERMAID_INIT_URL}"></script>`);
  });

  test("a document without one does not — nothing fetches the 3.5 MB bundle", () => {
    const plain = renderWeb("# Doc\n\n```js\nconst x = 1;\n```\n", OPTS);
    expect(plain).not.toContain(MERMAID_INIT_URL);
  });

  // In-place navigation can bring a diagram to a page that started without one.
  test("directory mode loads it either way", () => {
    const plain = renderWeb("# Doc\n\ntext\n", { ...OPTS, dirMode: true });
    expect(plain).toContain(MERMAID_INIT_URL);
  });

  test("the settings panel tells the page a font changed", () => {
    expect(PAGE).toContain('new CustomEvent("mdrfc:font")');
  });

  test("the bundle is named under the running version, so an upgrade lands", () => {
    expect(MERMAID_URL).toBe(`/_mermaid/${VERSION}/${MERMAID_FILE}`);
    expect(PAGE).toContain(`mermaidUrl: "${MERMAID_URL}"`);
  });
});

describe("the bundled browser build", () => {
  test("is on disk, and is the build that defines window.mermaid", () => {
    const buf = readMermaidBundle();
    expect(buf).not.toBeNull();
    expect(buf!.length).toBeGreaterThan(1_000_000);
    expect(buf!.toString("utf8", buf!.length - 200)).toContain('globalThis["mermaid"]');
  });
});

// ── the client module, against a stand-in for mermaid ─────────────────────
interface Config {
  theme?: string;
  fontFamily?: string;
  securityLevel?: string;
  suppressErrorRendering?: boolean;
  startOnLoad?: boolean;
}

let config: Config = {};
let bound: unknown[] = [];

/** Enough of mermaid's surface for the module: initialize, then render. */
const fake = {
  initialize(next: Config) {
    config = next;
  },
  render(id: string, src: string) {
    if (src.includes("boom")) return Promise.reject(new Error("Parse error on line 2"));
    return Promise.resolve({
      svg: `<svg data-id="${id}" data-drawn-in="${config.theme}"></svg>`,
      bindFunctions: (el: unknown) => bound.push(el),
    });
  },
};

function page(source: string): string {
  const html = renderWeb(`\`\`\`mermaid\n${source}\n\`\`\`\n`, OPTS);
  return box(html);
}

type Client = {
  render(): Promise<void>;
  redraw(): Promise<void>;
  syncSource(el: Element): void;
  revealSource(terms: string[]): boolean;
  zoom(el: Element | null): void;
  close(): void;
  refresh(): void;
};

/** Load the module over a fresh document already holding `html`. */
async function mount(html: string, mermaid: unknown = fake): Promise<Client> {
  GlobalRegistrator.register();
  document.body.innerHTML = `<main>${html}</main>`;
  (window as unknown as { mermaid: unknown }).mermaid = mermaid;
  config = {};
  bound = [];
  await import("../src/client/mermaid.js");
  const client = (window as unknown as { mdrfcMermaid: Client }).mdrfcMermaid;
  await client.render();
  return client;
}

describe("drawing a diagram in the browser", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("the drawing replaces the source, stamped with the palette it used", async () => {
    await mount(page("graph TD\n  A-->B"));
    const el = document.querySelector(".mdrfc-mermaid")!;
    expect(el.classList.contains("rendered")).toBe(true);
    expect(el.querySelector(".mdrfc-mermaid-out")!.innerHTML).toContain("<svg");
    expect((el as HTMLElement).dataset.mermaidTheme).toBe("default");
    expect(bound).toHaveLength(1);
  });

  test("mermaid is told not to draw its own errors, and to sanitize labels", async () => {
    await mount(page("graph TD\n  A-->B"));
    expect(config.securityLevel).toBe("strict");
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.startOnLoad).toBe(false);
  });

  // The highlighter skips chrome, so a hidden source must not be searchable —
  // a painted hit there would scroll to nothing.
  test("the hidden source leaves the search text, and returns when shown", async () => {
    const client = await mount(page("graph TD\n  A-->B"));
    const el = document.querySelector(".mdrfc-mermaid")!;
    const source = el.querySelector("pre")!;
    expect(source.hasAttribute("data-mdrfc-chrome")).toBe(true);

    el.classList.add("show-source");
    client.syncSource(el);
    expect(source.hasAttribute("data-mdrfc-chrome")).toBe(false);

    el.classList.remove("show-source");
    client.syncSource(el);
    expect(source.hasAttribute("data-mdrfc-chrome")).toBe(true);
  });

  test("a palette change draws it again, because the colours live in the SVG", async () => {
    const client = await mount(page("graph TD\n  A-->B"));
    const el = document.querySelector(".mdrfc-mermaid")! as HTMLElement;
    expect(el.dataset.mermaidTheme).toBe("default");

    document.documentElement.setAttribute("data-theme", "dark");
    await client.render();
    expect(el.dataset.mermaidTheme).toBe("dark");
    expect(el.querySelector(".mdrfc-mermaid-out")!.innerHTML).toContain('data-drawn-in="dark"');
  });

  test("the drawing is a handle for opening it, reachable by keyboard", async () => {
    await mount(page("graph TD\n  A-->B"));
    const out = document.querySelector("." + OUT)!;
    expect(out.getAttribute("role")).toBe("button");
    expect(out.getAttribute("tabindex")).toBe("0");
  });

  test("a diagram that will not parse keeps its source, and says why", async () => {
    await mount(page("boom -->"));
    const el = document.querySelector(".mdrfc-mermaid")!;
    expect(el.classList.contains("rendered")).toBe(false);
    expect(el.classList.contains("failed")).toBe(true);
    expect(el.querySelector("pre")!.hasAttribute("data-mdrfc-chrome")).toBe(false);
    expect(el.querySelector(".mdrfc-mermaid-err")!.textContent).toContain("Parse error on line 2");
  });
});

/** The SVG mermaid hands back, with the ids it namespaces under the diagram. */
const WITH_IDS = (id: string) =>
  `<svg id="${id}" viewBox="0 0 900 300" style="max-width: 900px;">` +
  `<defs><marker id="${id}_arrow"></marker></defs>` +
  `<path marker-end="url(#${id}_arrow)"></path></svg>`;

/** A stand-in that returns a diagram shaped the way mermaid's really is. */
const withIds = {
  initialize(next: Config) {
    config = next;
  },
  render(id: string) {
    return Promise.resolve({ svg: WITH_IDS(id), bindFunctions: undefined });
  },
};

describe("opening a diagram full screen", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("the copy is renamed throughout, so it cannot fight over its markers", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    const original = document.querySelector("." + OUT + " svg")!.getAttribute("id")!;
    client.zoom(document.querySelector(".mdrfc-mermaid"));

    const canvas = document.querySelector(".mdrfc-zoom-canvas")!;
    expect(canvas.innerHTML).not.toContain(original);
    // Both the id it declares and the reference that reaches for it move.
    expect(canvas.innerHTML).toMatch(/id="mdrfc-zoomed-\d+_arrow"/);
    expect(canvas.innerHTML).toMatch(/url\(#mdrfc-zoomed-\d+_arrow\)/);
    // The page's own drawing is left exactly as it was.
    expect(document.getElementById(original)).not.toBeNull();
  });

  test("the copy is sized from its viewBox, not the column it was drawn for", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    client.zoom(document.querySelector(".mdrfc-mermaid"));
    const copy = document.querySelector(".mdrfc-zoom-canvas svg")!;
    expect(copy.getAttribute("style")).toBeNull();
    expect(copy.getAttribute("width")).toBe("900");
    expect(copy.getAttribute("height")).toBe("300");
  });

  test("it is a modal dialog, and it takes focus and gives it back", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    const before = document.querySelector('[data-act="open"]') as HTMLElement;
    before.focus();

    client.zoom(document.querySelector(".mdrfc-mermaid"));
    const overlay = document.getElementById("mdrfc-zoom")!;
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(overlay.classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(overlay.querySelector('[data-zoom="close"]'));
    // The page behind must not scroll under a diagram being dragged over it.
    expect(document.body.style.overflow).toBe("hidden");

    client.close();
    expect(overlay.classList.contains("open")).toBe(false);
    expect(document.querySelector(".mdrfc-zoom-canvas")!.children).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(before);
  });

  test("escape closes it", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    client.zoom(document.querySelector(".mdrfc-mermaid"));
    const overlay = document.getElementById("mdrfc-zoom")!;
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlay.classList.contains("open")).toBe(false);
  });

  test("re-taking a diagram that lost its drawing closes rather than lingers", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    client.zoom(document.querySelector(".mdrfc-mermaid"));
    document.querySelector(".mdrfc-mermaid")!.classList.remove("rendered");
    client.refresh();
    expect(document.getElementById("mdrfc-zoom")!.classList.contains("open")).toBe(false);
  });

  test("a diagram with no drawing yet cannot be opened", async () => {
    const client = await mount(page("boom -->"), withIds);
    const box = document.querySelector(".mdrfc-mermaid")!;
    box.classList.remove("rendered");
    client.zoom(box);
    expect(document.getElementById("mdrfc-zoom")).toBeNull();
  });

  // The colours live inside the SVG, so a palette swap replaces the drawing
  // the overlay is showing.
  test("a palette change reaches the copy it is showing", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    client.zoom(document.querySelector(".mdrfc-mermaid"));
    const first = document.querySelector(".mdrfc-zoom-canvas svg")!.getAttribute("id");

    // What the palette listener does: draw the page again, then re-take.
    document.documentElement.setAttribute("data-theme", "dark");
    await client.render();
    client.refresh();

    const copy = document.querySelector(".mdrfc-zoom-canvas svg")!;
    expect(copy.getAttribute("id")).not.toBe(first);
    expect(document.getElementById("mdrfc-zoom")!.classList.contains("open")).toBe(true);
  });

  /** A press, as the stage sees one, on `el`. */
  function press(el: Element): void {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  }

  // Nothing inside the overlay holds focus once the stage has been pressed, so
  // keys watched from the overlay alone would go dead after the first pan.
  test("the keys still answer after a press has taken focus off the button", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    client.zoom(document.querySelector(".mdrfc-mermaid"));
    const overlay = document.getElementById("mdrfc-zoom")!;
    press(document.querySelector(".mdrfc-zoom-stage")!);
    (document.body as HTMLElement).focus();

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlay.classList.contains("open")).toBe(false);
  });

  // Pointer capture retargets the click to the stage, so an identity check on
  // the target would read a click on a node as a click past the diagram.
  test("clicking the drawing itself does not close it", async () => {
    const client = await mount(page("graph TD\n  A-->B"), withIds);
    client.zoom(document.querySelector(".mdrfc-mermaid"));
    const stage = document.querySelector(".mdrfc-zoom-stage")!;

    press(document.querySelector(".mdrfc-zoom-canvas svg")!);
    stage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("mdrfc-zoom")!.classList.contains("open")).toBe(true);

    press(stage);
    stage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("mdrfc-zoom")!.classList.contains("open")).toBe(false);
  });
});

describe("a diagram redrawn for something other than the palette", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  // The face is read at render time and written into the SVG, so the palette
  // stamp cannot tell that a font change left the drawing stale.
  test("a font change draws it again, in the face the body now wears", async () => {
    const client = await mount(page("graph TD\n  A-->B"));
    expect(config.fontFamily).not.toBe("Iosevka");
    document.body.style.fontFamily = "Iosevka";

    await client.redraw();
    expect(config.fontFamily).toBe("Iosevka");
    expect(bound).toHaveLength(2);
  });
});

describe("a search hit inside a diagram's source", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("shows the source again, so the highlighter has something to paint", async () => {
    const client = await mount(page("graph TD\n  A-->B"));
    const el = document.querySelector(".mdrfc-mermaid")!;
    expect(el.querySelector("pre")!.hasAttribute("data-mdrfc-chrome")).toBe(true);

    expect(client.revealSource(["graph"])).toBe(true);
    expect(el.classList.contains("show-source")).toBe(true);
    expect(el.querySelector("pre")!.hasAttribute("data-mdrfc-chrome")).toBe(false);
    // The toolbar must say what the block is now showing.
    expect(el.querySelector('[data-act="source"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  test("a term the diagram does not hold leaves it drawn", async () => {
    const client = await mount(page("graph TD\n  A-->B"));
    expect(client.revealSource(["graph", "nowhere"])).toBe(false);
    expect(client.revealSource([])).toBe(false);
    expect(document.querySelector(".mdrfc-mermaid")!.classList.contains("show-source")).toBe(false);
  });
});
