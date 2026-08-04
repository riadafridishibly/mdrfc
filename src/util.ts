import { spawn } from "node:child_process";
import net from "node:net";

export type Theme = "auto" | "light" | "dark";

export interface RenderOpts {
  width: number;
  color: boolean;
  theme: Theme;
}

export const RFC_WIDTH = 72;

/** Strip ANSI escape codes (color strip for --no-color mode). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Read all of stdin as utf8 text. */
export async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

/** Probe whether a TCP port is free. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

/** Find first free port starting at `start`, up to `maxTries` increments. */
export async function findFreePort(start: number, maxTries = 50): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found starting at ${start}`);
}

/**
 * Pipe rendered text through `less -RFX` if stdout is a TTY and `less` exists.
 * -R  = pass through raw ANSI (colors)
 * -F  = quit if content fits one screen
 * -X  = don't clear screen on exit
 * -K  = exit on SIGINT
 * Otherwise just print to stdout.
 */
export function pageOutput(text: string): void {
  const isTTY = process.stdout.isTTY === true;
  if (!isTTY) {
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    return;
  }
  const p = spawn("less", ["-RFXK"], { stdio: ["pipe", "inherit", "inherit"] });
  p.stdin.write(text);
  p.stdin.end();
  p.on("error", () => {
    // less not available → just print
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
  });
}
