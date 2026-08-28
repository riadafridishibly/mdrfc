import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderWeb, type TreeNode } from "../src/render/web.ts";
import { RFC_WIDTH } from "../src/util.ts";

/**
 * The filetree, driven as shipped: the markup and the inline script come out
 * of the rendered page rather than being restated here.
 */
const TREE: TreeNode = {
  name: "docs",
  path: "",
  dir: true,
  children: [{ name: "a.md", path: "a.md", dir: false, children: [] }],
};

const PAGE = renderWeb(
  "# Doc\n\ntext\n",
  { width: RFC_WIDTH, color: false, theme: "auto", frontmatter: true },
  undefined,
  TREE,
  "a.md",
);

/** The sidebar IIFE — the only inline script that wires up the tree. */
function sidebarScript(): string {
  const scripts = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const src = scripts.map((m) => m[1]).find((s) => s.includes("treeClosed"));
  if (!src) throw new Error("sidebar script not found in rendered page");
  return src;
}

/** The toggle, the tree and the drag handle, i.e. everything the script binds to. */
function sidebarMarkup(): string {
  const start = PAGE.indexOf('<button id="mdrfc-sidebar-toggle"');
  const resizer = PAGE.indexOf('id="mdrfc-resizer"', start);
  const end = PAGE.indexOf("</div>", resizer);
  if (start < 0 || resizer < 0 || end < 0) throw new Error("sidebar not found in rendered page");
  return PAGE.slice(start, end + "</div>".length);
}

let toggle: HTMLElement;
let resizer: HTMLElement;
/**
 * How many times the tree has asked for the placement to be worked out again.
 * The real one is in the placement script; here it only has to be countable.
 */
let relayouts: number;

const root = () => document.documentElement;
const collapsed = () => root().classList.contains("mdrfc-sidebar-collapsed");

function mount() {
  document.body.innerHTML = sidebarMarkup() + "<main></main>";
  relayouts = 0;
  (window as any).mdrfcToc = {
    relayout() {
      relayouts++;
    },
  };
  new Function(sidebarScript())();
  toggle = document.getElementById("mdrfc-sidebar-toggle")!;
  resizer = document.getElementById("mdrfc-resizer")!;
}

function click(el: HTMLElement) {
  el.dispatchEvent(new Event("click", { bubbles: true }));
}

beforeEach(() => {
  GlobalRegistrator.register();
  mount();
});

afterEach(async () => {
  localStorage.clear();
  await GlobalRegistrator.unregister();
});

describe("filetree", () => {
  test("the toggle collapses the tree and remembers it", () => {
    click(toggle);
    expect(collapsed()).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("mdrfc.sidebarCollapsed")).toBe("1");
  });

  /**
   * The tree is fixed and slides on a transform, so opening or closing it
   * moves neither the body's content box nor the document's own rect — there
   * is nothing for the observer to catch. The room the tree takes out of the
   * page comes back only when the placement is worked out again.
   */
  test("opening or closing it asks for the page box to be worked out again", () => {
    expect(relayouts).toBe(0); // the boot pass only reads the state back, it moves nothing
    click(toggle);
    expect(relayouts).toBe(1);
    click(toggle);
    expect(relayouts).toBe(2);
  });

  test("Ctrl-B does too", () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(collapsed()).toBe(true);
    expect(relayouts).toBe(1);
  });

  test("resizing the tree does too, since its column is room the text loses", () => {
    resizer.dispatchEvent(new Event("dblclick", { bubbles: true }));
    expect(root().style.getPropertyValue("--sidebar-w")).toBe("248px");
    expect(relayouts).toBe(1);
  });

  test("a tree stored collapsed is already placed, and asks for nothing", () => {
    root().classList.add("mdrfc-sidebar-collapsed"); // as the boot script leaves it
    mount();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(relayouts).toBe(0);
  });

  test("the tree works on a page with no contents column to place", () => {
    delete (window as any).mdrfcToc;
    click(toggle);
    expect(collapsed()).toBe(true);
  });
});
