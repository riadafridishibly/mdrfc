import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The palette imports from "/_preact.js" and "/_highlight.js", the URLs the
 * server exposes those modules at. Rewrite those two specifiers to real paths
 * so the module can be imported here — everything else is loaded verbatim.
 */
async function loadPalette() {
  const runtime = resolve("node_modules/htm/preact/standalone.module.js");
  const src = await Bun.file("src/client/palette.js").text();
  const patched = src
    .replace('from "/_preact.js"', `from ${JSON.stringify(runtime)}`)
    .replace('from "/_highlight.js"', `from ${JSON.stringify(resolve("src/client/highlight.js"))}`);
  const file = join(mkdtempSync(join(tmpdir(), "mdrfc-palette-")), "palette.js");
  writeFileSync(file, patched);
  await import(file);
}

const DOC = `
  <main>
    <h1 id="fixture-docs">Fixture Docs</h1>
    <h2 id="getting-started">Getting Started</h2>
    <h2 id="troubleshooting">Troubleshooting</h2>
  </main>
`;

/** What /_search returns for "socket": no heading of the open document matches. */
const ENVELOPE = {
  extended: false,
  hits: [
    {
      kind: "heading",
      path: "guide/advanced-config.md",
      name: "advanced-config.md",
      line: 3,
      text: "Socket tuning",
      anchor: "socket-tuning",
      score: 62,
      range: [0, 6],
    },
    {
      kind: "text",
      path: "guide/advanced-config.md",
      name: "advanced-config.md",
      line: 5,
      text: "Set the socket timeout to 30s.",
      anchor: "socket-tuning",
      score: 10,
      range: [8, 6],
    },
  ],
};

let fetched: string[] = [];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const rows = () => document.querySelectorAll(".mdrfc-p-row");
const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null;

async function openPalette() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  await tick();
}

async function type(value: string) {
  const input = document.querySelector(".mdrfc-p-input") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick(140); // clear the 80ms debounce
}

beforeEach(async () => {
  GlobalRegistrator.register();
  document.body.innerHTML = DOC;
  (window as any).__mdrfc = { dirMode: true };
  fetched = [];
  (globalThis as any).fetch = async (url: string) => {
    fetched.push(url);
    const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
    const hits = q.toLowerCase().includes("socket") ? ENVELOPE.hits : [];
    return new Response(JSON.stringify({ extended: false, hits }), {
      headers: { "content-type": "application/json" },
    });
  };
  await loadPalette();
  await tick(60); // let Preact flush the mount effects that bind Cmd-K
});

afterEach(async () => {
  await GlobalRegistrator.unregister();
});

describe("command palette", () => {
  test("stays closed until Cmd-K", () => {
    expect(document.querySelector(".mdrfc-p-box")).toBeNull();
  });

  test("Cmd-K opens it", async () => {
    await openPalette();
    expect(document.querySelector(".mdrfc-p-box")).not.toBeNull();
  });

  test("an empty query lists the document outline", async () => {
    await openPalette();
    expect(rows().length).toBe(3);
    expect(rows()[0].textContent).toContain("Fixture Docs");
  });

  test("an empty query shows the syntax legend", async () => {
    await openPalette();
    expect(text(".mdrfc-p-hint")).toContain("starts");
  });

  test("typing filters the outline without a request", async () => {
    await openPalette();
    await type("getting");
    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain("Getting Started");
  });

  // The regression that matters: a query matching no heading of the open
  // document must still surface the server's results rather than "No matches".
  test("server results render when no local heading matches", async () => {
    await openPalette();
    await type("socket");
    expect(fetched.some((u) => u.includes("q=socket"))).toBe(true);
    expect(document.querySelector(".mdrfc-p-empty")).toBeNull();
    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain("Socket tuning");
  });

  test("server hits group under one file header", async () => {
    await openPalette();
    await type("socket");
    const heads = document.querySelectorAll(".mdrfc-p-file");
    expect(heads.length).toBe(2); // one per group: Headings, Content
    expect(heads[0].textContent).toContain("advanced-config.md");
  });

  test("no matches reports so", async () => {
    await openPalette();
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ extended: false, hits: [] }), {
        headers: { "content-type": "application/json" },
      });
    await type("zzzznothing");
    expect(text(".mdrfc-p-empty")).toBe("No matches");
  });

  // A failing search used to be swallowed, so a stale client talking to a
  // changed server looked exactly like an empty result set.
  test("a failed search is reported, not shown as No matches", async () => {
    await openPalette();
    (globalThis as any).fetch = async () => new Response("nope", { status: 500 });
    await type("socket");
    expect(text(".mdrfc-p-empty")).not.toBe("No matches");
    expect(text(".mdrfc-p-hint.error")).toContain("500");
  });

  test("an unexpected response shape is reported", async () => {
    await openPalette();
    // the pre-envelope shape: a bare array where {hits, extended} is expected
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify([{ kind: "file", path: "a.md" }]), {
        headers: { "content-type": "application/json" },
      });
    await type("socket");
    expect(document.querySelector(".mdrfc-p-hint.error")).not.toBeNull();
  });

  test("Escape closes it", async () => {
    await openPalette();
    const input = document.querySelector(".mdrfc-p-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(document.querySelector(".mdrfc-p-box")).toBeNull();
  });
});
