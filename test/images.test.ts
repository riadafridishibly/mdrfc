import { afterAll, beforeAll, describe, expect, test } from "./harness.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { assetType, isIgnoredPath, startServer } from "../src/server.ts";
import { renderWeb } from "../src/render/web.ts";
import { RFC_WIDTH, type RenderOpts } from "../src/util.ts";

const OPTS: RenderOpts = {
  width: RFC_WIDTH,
  color: false,
  theme: "auto",
  frontmatter: true,
};

const PNG = Buffer.from("89504e470d0a1a0a", "hex"); // the PNG signature, and nothing else

/**
 * A directory with a document at the root and one a level down, both with
 * images — served out of a subdirectory, so there is a real image one level
 * above it for the traversal case to try to reach.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mdrfc-images-"));
  const dir = join(root, "served");
  mkdirSync(join(dir, "guide", "img"), { recursive: true });
  writeFileSync(join(root, "outside.png"), PNG);
  writeFileSync(join(dir, "logo.png"), PNG);
  writeFileSync(join(dir, "guide", "img", "chart.png"), PNG);
  writeFileSync(join(dir, "secrets.env"), "TOKEN=hunter2\n");
  writeFileSync(join(dir, "evil.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  writeFileSync(join(dir, "README.md"), "# Root\n\n![logo](logo.png)\n");
  writeFileSync(
    join(dir, "guide", "page.md"),
    "# Guide\n\n![chart](img/chart.png)\n\n![up](../logo.png)\n"
  );
  return dir;
}

describe("assetType", () => {
  test("names the type of every image extension served", () => {
    expect(assetType("a.png")).toBe("image/png");
    expect(assetType("dir/a.JPG")).toBe("image/jpeg");
    expect(assetType("a.jpeg")).toBe("image/jpeg");
    expect(assetType("a.svg")).toBe("image/svg+xml");
  });

  test("leaves everything else alone", () => {
    expect(assetType("a.md")).toBeNull();
    expect(assetType("a.env")).toBeNull();
    expect(assetType("a.png.txt")).toBeNull();
    expect(assetType("png")).toBeNull();
    expect(assetType("/")).toBeNull();
  });
});

describe("rendered markup", () => {
  test("a relative image keeps its path, so it resolves against the page", () => {
    const html = renderWeb("![logo](img/logo.png)", OPTS);
    expect(html).toContain('<img src="img/logo.png" alt="logo">');
  });
});

describe("serving images", () => {
  let base = "";
  let server: Server;

  beforeAll(async () => {
    const dir = fixture();
    server = await startServer({
      content: "",
      source: join(dir, "README.md"),
      baseDir: dir,
      dirMode: true,
      port: 0,
      open: false,
      ...OPTS,
    });
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  test("an image beside the document is served as itself", async () => {
    const res = await fetch(`${base}/logo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBeTruthy();
  });

  test("an image under a subdirectory is served too", async () => {
    const res = await fetch(`${base}/guide/img/chart.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("a missing image is a 404, not the document", async () => {
    const res = await fetch(`${base}/nope.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
  });

  test("nothing outside the served directory is reachable", async () => {
    // A literal `..` segment never survives the URL parser, so the traversal
    // guard is only ever reached by an escaped one — which is what is worth
    // testing. `outside.png` is really on disk, one level up from the root
    // being served, so a 404 here is the guard and not a missing file.
    for (const path of ["/..%2foutside.png", "/%2f..%2foutside.png", "/%2e%2e%2foutside.png"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
    }
  });

  test("an svg cannot run its own script on the origin serving the documents", async () => {
    const res = await fetch(`${base}/evil.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a file that is not an image is not served", async () => {
    const res = await fetch(`${base}/secrets.env`);
    expect(await res.text()).not.toContain("hunter2");
  });
});

describe("watched paths", () => {
  test("an image the file tree lists is watched", () => {
    expect(isIgnoredPath("logo.png")).toBeFalsy();
    expect(isIgnoredPath("guide/img/chart.png")).toBeFalsy();
    expect(isIgnoredPath("guide/page.md")).toBeFalsy();
    // A hidden file is still served, so it is still watched — only hidden
    // *directories*, which the sidebar never lists, are dropped.
    expect(isIgnoredPath(".icon.png")).toBeFalsy();
  });

  test("churn under dependency and VCS directories is not", () => {
    // An `npm install` or a branch switch writes thousands of these; without
    // the filter each one carrying an image extension reloads every open tab.
    expect(isIgnoredPath("node_modules/pkg/logo.png")).toBeTruthy();
    expect(isIgnoredPath(".git/objects/ab/cd.png")).toBeTruthy();
    expect(isIgnoredPath("dist/assets/app.svg")).toBeTruthy();
    expect(isIgnoredPath(".next/static/a.png")).toBeTruthy();
    expect(isIgnoredPath("docs/node_modules/x/a.md")).toBeTruthy();
    expect(isIgnoredPath("node_modules\\pkg\\logo.png")).toBeTruthy();
  });
});
