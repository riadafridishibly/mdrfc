/**
 * One-time notices about what has changed in the web view.
 *
 * A setting a reader has already saved is theirs: a new default never
 * overwrites it. So when mdrfc starts doing something a saved setting hides —
 * the bundled font, say, which an explicit font choice sits in front of — the
 * page offers it once rather than taking it. Accepted or dismissed, the answer
 * is recorded in `localStorage` under `mdrfc.ann.<id>` and that notice is done.
 *
 * To announce something new, add an entry. `when` and `action` name functions
 * in the page's own registries (see `ANN_WHEN` / `ANN_DO` in the settings
 * script): `when` decides whether the notice is worth showing this reader,
 * `action` is what accepting it does. Both are names rather than code so the
 * page never evaluates a string.
 */

/** Whether a notice applies to this reader. */
export type AnnounceWhen =
  | "always"
  /** They have picked a font of their own, so the bundled one is not in use. */
  | "font-overridden";

/** What accepting a notice does. */
export type AnnounceAction =
  /** Drop the saved font, landing back on the stylesheet's bundled family. */
  "use-bundled-font";

export interface Announcement {
  /** Storage key suffix. A new id announces the same thing again; reuse means never. */
  id: string;
  title: string;
  body: string;
  /** Label of the button that takes the offer. */
  accept: string;
  /** Label of the button that declines it. */
  dismiss: string;
  when: AnnounceWhen;
  action: AnnounceAction;
}

export const ANNOUNCEMENTS: Announcement[] = [
  {
    id: "bundled-font-1",
    title: "mdrfc now ships a font",
    body:
      "Pages are set in Iosevka Brick, served by mdrfc itself. " +
      "The font you picked is still in force — this only offers the new one.",
    accept: "Try it",
    dismiss: "Keep mine",
    when: "font-overridden",
    action: "use-bundled-font",
  },
];
