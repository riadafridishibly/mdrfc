import { describe, expect, test } from "./harness.ts";
import { hasBrowser } from "../src/util.ts";

/**
 * Which view a bare `mdrfc x.md` lands in. A terminal is someone watching, but
 * not always from the machine the browser would open on.
 */
describe("where a document opens", () => {
  test("a local terminal has a browser to open", () => {
    expect(hasBrowser({})).toBe(true);
    expect(hasBrowser({ DISPLAY: ":0" })).toBe(true);
  });

  test("an SSH session with no display does not", () => {
    expect(hasBrowser({ SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" })).toBe(false);
    expect(hasBrowser({ SSH_TTY: "/dev/pts/0" })).toBe(false);
    expect(hasBrowser({ SSH_CLIENT: "10.0.0.2 51000 22" })).toBe(false);
  });

  test("an SSH session forwarding a display does", () => {
    expect(hasBrowser({ SSH_CONNECTION: "x", DISPLAY: "localhost:10.0" })).toBe(true);
    expect(hasBrowser({ SSH_TTY: "/dev/pts/0", WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
  });
});
