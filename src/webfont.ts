import { readFileSync } from "node:fs";

/**
 * The typeface the web view ships with, so a page reads the same on a machine
 * that has never installed a monospace font as on one that has a dozen.
 *
 * Iosevka Brick (https://github.com/riadafridishibly/Iosevka-Brick), built as
 * WOFF2 and subset to the ranges a markdown document actually reaches for —
 * Latin, Greek, Cyrillic, punctuation, currency, arrows, maths, box drawing and
 * geometric symbols. Anything outside them falls through to the system stack,
 * which is what an unsubset font would have to be downloaded in full to avoid.
 * To rebuild from a fresh Iosevka-Brick checkout:
 *
 *   uvx --from "fonttools[woff]" --with brotli pyftsubset \
 *     dist/IosevkaBrick/WOFF2/IosevkaBrick-<weight>.woff2 \
 *     --output-file=src/webfonts/IosevkaBrick-<weight>.woff2 \
 *     --flavor=woff2 --layout-features='*' --unicodes="$(cat src/webfonts/RANGES)"
 */

export const WEBFONT_FAMILY = "Iosevka Brick";

/** URL prefix the server answers font requests on. */
export const WEBFONT_PATH = "/_font/";

interface Face {
  file: string;
  weight: number;
  style: "normal" | "oblique 9deg";
}

const FACES: Face[] = [
  { file: "IosevkaBrick-Regular.woff2", weight: 400, style: "normal" },
  { file: "IosevkaBrick-Oblique.woff2", weight: 400, style: "oblique 9deg" },
  { file: "IosevkaBrick-Bold.woff2", weight: 700, style: "normal" },
  { file: "IosevkaBrick-BoldOblique.woff2", weight: 700, style: "oblique 9deg" },
];

/** The face a page should fetch before it paints anything. */
export const WEBFONT_PRELOAD = WEBFONT_PATH + FACES[0].file;

/**
 * `@font-face` rules for the bundled family. `swap` rather than `block`: the
 * fallback stack is monospace too, so the reflow when the real face lands is a
 * change of shape, not of layout, and no reader waits on the network for it.
 */
export const WEBFONT_CSS = FACES.map(
  (f) => `  @font-face {
    font-family: "${WEBFONT_FAMILY}";
    src: url("${WEBFONT_PATH}${f.file}") format("woff2");
    font-weight: ${f.weight};
    font-style: ${f.style};
    font-display: swap;
  }`
).join("\n");

const bytes = new Map<string, Buffer>();

/** The bytes of a bundled face, or null if `file` is not one of them. */
export function readWebfont(file: string): Buffer | null {
  if (!FACES.some((f) => f.file === file)) return null;
  const cached = bytes.get(file);
  if (cached) return cached;
  try {
    const buf = readFileSync(new URL(`./webfonts/${file}`, import.meta.url));
    bytes.set(file, buf);
    return buf;
  } catch {
    return null; // shipped without the font files; the fallback stack still reads
  }
}
