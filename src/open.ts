import { exec } from "node:child_process";

/**
 * Cross-platform "open URL in default browser".
 * macOS → `open`
 * Linux → `xdg-open`
 * Windows → `start` (via cmd)
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") cmd = `open ${JSON.stringify(url)}`;
  else if (platform === "win32") cmd = `start "" ${JSON.stringify(url)}`;
  else cmd = `xdg-open ${JSON.stringify(url)}`;

  exec(cmd, (err) => {
    if (err) {
      // fall back: print URL so user can click
      console.error(`Could not auto-open browser. Open manually: ${url}`);
    }
  });
}
