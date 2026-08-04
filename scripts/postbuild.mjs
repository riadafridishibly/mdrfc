// Post-build step: ad-hoc codesign binaries on macOS so they don't get killed
// by Gatekeeper on first run ("Killed: 9"). No-op on other platforms.
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("postbuild: no binary path given or missing");
  process.exit(1);
}

if (platform() === "darwin") {
  try {
    execFileSync("codesign", ["--sign", "-", "--force", file], {
      stdio: "inherit",
    });
    console.log(`postbuild: signed ${file}`);
  } catch (e) {
    console.error(
      `postbuild: codesign failed (binary may be killed on first run): ${e.message}`
    );
    process.exit(0); // non-fatal
  }
} else {
  console.log(`postbuild: nothing to do on ${platform()}`);
}
