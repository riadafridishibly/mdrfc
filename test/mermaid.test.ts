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

  test("offers source and copy, and not the wrap toggle a drawing cannot use", () => {
    const tools = box(PAGE);
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

type Client = { render(): Promise<void>; syncSource(el: Element): void };

/** Load the module over a fresh document already holding `html`. */
async function mount(html: string): Promise<Client> {
  GlobalRegistrator.register();
  document.body.innerHTML = `<main>${html}</main>`;
  (window as unknown as { mermaid: unknown }).mermaid = fake;
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

  test("a diagram that will not parse keeps its source, and says why", async () => {
    await mount(page("boom -->"));
    const el = document.querySelector(".mdrfc-mermaid")!;
    expect(el.classList.contains("rendered")).toBe(false);
    expect(el.classList.contains("failed")).toBe(true);
    expect(el.querySelector("pre")!.hasAttribute("data-mdrfc-chrome")).toBe(false);
    expect(el.querySelector(".mdrfc-mermaid-err")!.textContent).toContain("Parse error on line 2");
  });
});
