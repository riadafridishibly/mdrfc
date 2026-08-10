import { describe, expect, test } from "bun:test";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

const HTML = renderWeb("# Doc\n\ntext\n", OPTS);

/** The custom properties a rule declares, by the selector that opens it. */
function tokens(selector: string): Map<string, string> {
  const at = HTML.indexOf(selector + " {");
  expect(at).toBeGreaterThan(-1);
  const block = HTML.slice(at, HTML.indexOf("}", at));
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

describe("dark palette", () => {
  // A token reaching only one of them paints its text over its own colour —
  // which is what the picked search line did in the OS dark theme.
  test("the forced theme and the OS one define exactly the same tokens", () => {
    const forced = tokens('html[data-theme="dark"]');
    const os = tokens('html:not([data-theme="light"])');
    expect(forced.size).toBeGreaterThan(0);
    expect([...os]).toEqual([...forced]);
  });

  test("every colour the light theme names is answered in the dark one", () => {
    const light = tokens(":root");
    const dark = tokens('html[data-theme="dark"]');
    for (const name of light.keys()) {
      if (name === "--font-size" || name === "--content-w" || name === "--sidebar-w") continue;
      expect(dark.has(name)).toBe(true);
    }
  });
});
