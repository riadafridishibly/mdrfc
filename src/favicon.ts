/**
 * The site icon: an "MR" monogram where the M's right stem doubles as the R's,
 * so both letters fit a square tile without shrinking to mush at 16px.
 *
 * Letters are stroked paths, not <text>: a favicon is rasterised outside the
 * page, where the document's monospace font stack does not apply and each
 * browser would otherwise pick its own face.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="mdrfc">
  <rect width="32" height="32" rx="7" fill="#2563eb"/>
  <g fill="none" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" transform="translate(.88 .28)">
    <path d="M5 24V8l5.5 7L16 8v16"/>
    <path d="M16 8h5.5a4 4 0 0 1 0 8H16"/>
    <path d="m20.5 16 6 8"/>
  </g>
</svg>
`;

/** Path the icon is served from, and the one the document links to. */
export const FAVICON_PATH = "/favicon.svg";
