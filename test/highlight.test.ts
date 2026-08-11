import { afterEach, beforeEach, describe, expect, test } from "./harness.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CSS Custom Highlight API is absent from happy-dom, so stand in for it:
 * a registry of named highlights, each holding the ranges handed to it. That
 * is the whole contract the module relies on.
 */
class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function installHighlightApi() {
  // happy-dom defines CSS as a read-only accessor, hence defineProperty.
  Object.defineProperty(globalThis, "Highlight", { value: FakeHighlight, configurable: true });
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights: new Map<string, FakeHighlight>() },
    configurable: true,
  });
}

/**
 * Shaped like marked's output: blocks separated by newlines, and a soft line
 * break inside a paragraph left as the newline the source had.
 */
const DOC = `
<main>
<h1 id="fixture-docs">Fixture Docs</h1>
<p>The Socket tuning notes below explain the rest.</p>
<h2 id="socket-tuning">Socket tuning</h2>
<p>Set the socket timeout to 30s.
A later line raises the socket backlog.</p>
<p>Another socket mention lives further down.</p>
<ul>
<li>Tune the <code>socket</code> buffer, see <a href="/net.md">networking</a>.</li>
</ul>
</main>
`;

/** The same document with the contents list and a code block's toolbar. */
const CHROME_DOC = `
<main>
<nav id="mdrfc-toc" class="mdrfc-toc" data-mdrfc-chrome><ol><li><a href="#socket-tuning">Socket tuning</a></li></ol></nav>
<h2 id="socket-tuning">Socket tuning</h2>
<div class="mdrfc-code"><div class="mdrfc-code-tools" data-mdrfc-chrome><button>wrap</button><button>copy</button></div><pre><code>set socket timeout 30
</code></pre></div>
</main>
`;

const painted = (name: string): FakeHighlight | undefined =>
  (globalThis as any).CSS.highlights.get(name);
const texts = (name: string) => (painted(name)?.ranges ?? []).map((r) => r.toString());
/** The single range of a highlight, as text. */
const only = (name: string) => {
  const ranges = painted(name)?.ranges ?? [];
  expect(ranges.length).toBe(1);
  return ranges[0].toString();
};

/**
 * `supported` is decided when the module loads, so the stub has to be in place
 * before the first import. Load a copy rather than the file itself: the palette
 * suite imports the original in the same process, and whichever ran first would
 * otherwise fix that decision for both.
 */
async function loadHighlight() {
  const src = readFileSync(new URL("../src/client/highlight.js", import.meta.url), "utf8");
  const file = join(mkdtempSync(join(tmpdir(), "mdrfc-highlight-")), "highlight.js");
  writeFileSync(file, src);
  return import(file);
}

let mod: typeof import("../src/client/highlight.js");

beforeEach(async () => {
  GlobalRegistrator.register();
  installHighlightApi();
  mod ??= (await loadHighlight()) as typeof mod;
  document.body.innerHTML = DOC;
});

afterEach(async () => {
  await GlobalRegistrator.unregister();
  // The stub outlives this file otherwise, and the palette suite would decide
  // the API is there when it is not.
  delete (globalThis as any).Highlight;
  delete (globalThis as any).CSS;
});

describe("search highlighting", () => {
  test("bands the whole line the palette row listed", () => {
    const ok = mod.highlightMatches("socket", {
      anchor: "socket-tuning",
      snippet: "A later line raises the socket backlog.",
    });
    expect(ok).toBe(true);
    expect(only("mdrfc-hit-line")).toBe("A later line raises the socket backlog.");
  });

  test("the query is marked inside that line, and faintly outside it", () => {
    mod.highlightMatches("socket", { snippet: "A later line raises the socket backlog." });
    expect(texts("mdrfc-hit-current")).toEqual(["socket"]);
    expect(texts("mdrfc-hit").length).toBe(5); // the other five occurrences
  });

  // The prose above the heading quotes it, and comes first in the document —
  // the hit's own section is what decides.
  test("a heading row bands the heading, not an earlier line quoting it", () => {
    mod.highlightMatches("socket", { anchor: "socket-tuning", snippet: "Socket tuning" });
    expect(only("mdrfc-hit-line")).toBe("Socket tuning");
  });

  test("markdown in the row is stripped before matching", () => {
    mod.highlightMatches("socket", {
      snippet: "- Tune the `socket` buffer, see [networking](/net.md).",
    });
    expect(only("mdrfc-hit-line")).toBe("Tune the socket buffer, see networking.");
  });

  test("a row elided by the palette still finds its line", () => {
    mod.highlightMatches("socket", { snippet: "…raises the socket backlog." });
    expect(only("mdrfc-hit-line")).toBe("A later line raises the socket backlog.");
  });

  test("without a row the line at the hit's heading is banded", () => {
    mod.highlightMatches("socket", { anchor: "socket-tuning" });
    expect(only("mdrfc-hit-line")).toBe("Socket tuning");
  });

  // The rendering can leave a hit unrecognisable — a heading of pure inline
  // markup, say. The jump is still worth showing.
  test("a heading is banded even when the query itself is nowhere", () => {
    expect(mod.highlightMatches("zzzznothing", { anchor: "socket-tuning" })).toBe(true);
    expect(only("mdrfc-hit-line")).toBe("Socket tuning");
    expect(painted("mdrfc-hit-current")).toBeUndefined();
  });

  test("every term of a multi-word query is painted", () => {
    mod.highlightMatches("socket timeout", { snippet: "Set the socket timeout to 30s." });
    expect(texts("mdrfc-hit-current")).toEqual(["socket", "timeout"]);
  });

  test("nothing is painted when neither query nor heading resolves", () => {
    expect(mod.highlightMatches("zzzznothing", {})).toBe(false);
    expect(painted("mdrfc-hit")).toBeUndefined();
    expect(painted("mdrfc-hit-line")).toBeUndefined();
  });

  test("clearing removes every highlight", () => {
    mod.highlightMatches("socket", { anchor: "socket-tuning" });
    mod.clearHighlights();
    for (const name of ["mdrfc-hit", "mdrfc-hit-line", "mdrfc-hit-current"]) {
      expect(painted(name)).toBeUndefined();
    }
  });

  // The contents list repeats every heading and the code toolbar's labels run
  // straight into the first line of the block; neither is text the document
  // says, so neither is text a hit can land on.
  describe("chrome the renderer injected", () => {
    beforeEach(() => {
      document.body.innerHTML = CHROME_DOC;
    });

    test("does not join the line a hit is banded on", () => {
      mod.highlightMatches("socket", { snippet: "set socket timeout 30" });
      expect(only("mdrfc-hit-line")).toBe("set socket timeout 30");
    });

    test("is not itself searchable", () => {
      expect(mod.highlightMatches("copy", {})).toBe(false);
    });

    test("does not double a heading's own hits", () => {
      mod.highlightMatches("tuning", { anchor: "socket-tuning" });
      expect(texts("mdrfc-hit-current")).toEqual(["tuning"]);
    });
  });

  test("fzf's path operators are not searched for in prose", () => {
    expect(mod.contentTerms("^guide 'exact .md$ !draft a | b")).toEqual([
      "guide",
      "exact",
      ".md",
      "a",
      "b",
    ]);
  });
});
