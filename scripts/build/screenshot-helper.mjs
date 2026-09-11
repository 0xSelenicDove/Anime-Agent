import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyScreenshotHelper } from "../verify/screenshot-helper.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");
const manifestPath = path.join(
  repoRoot,
  "native",
  "cyrene-screenshot",
  "Cargo.toml",
);

function cargoBuild(extraArgs) {
  const result = spawnSync("cargo", [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    manifestPath,
    ...extraArgs,
  ], {
    cwd: repoRoot,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[screenshot-helper] failed to launch Cargo: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function buildWindows() {
  const builtHelperPath = path.join(
    repoRoot,
    "native",
    "cyrene-screenshot",
    "target",
    "release",
    "cyrene-screenshot.exe",
  );
  const stagedHelperPath = path.join(repoRoot, "resources", "bin", "cyrene-screenshot.exe");

  cargoBuild([]);

  await mkdir(path.dirname(stagedHelperPath), { recursive: true });
  await copyFile(builtHelperPath, stagedHelperPath);
  return stagedHelperPath;
}

// Builds both Apple Silicon and Intel targets and lipo's them into one
// universal binary — matches electron-builder.mac.yml's existing dual-arch
// (x64 + arm64) dmg/zip targets without needing per-arch resource selection
// in the packaged app.
async function buildMac() {
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  const perArchPaths = [];
  for (const target of targets) {
    cargoBuild(["--target", target]);
    perArchPaths.push(
      path.join(repoRoot, "native", "cyrene-screenshot", "target", target, "release", "cyrene-screenshot"),
    );
  }

  const stagedHelperPath = path.join(repoRoot, "resources", "bin", "cyrene-screenshot");
  await mkdir(path.dirname(stagedHelperPath), { recursive: true });
  const lipo = spawnSync("lipo", ["-create", "-output", stagedHelperPath, ...perArchPaths], {
    cwd: repoRoot,
    shell: false,
    stdio: "inherit",
  });
  if (lipo.error) {
    console.error(`[screenshot-helper] failed to launch lipo: ${lipo.error.message}`);
    process.exit(1);
  }
  if (lipo.status !== 0) {
    process.exit(lipo.status ?? 1);
  }
  const chmod = spawnSync("chmod", ["+x", stagedHelperPath], { stdio: "inherit" });
  if (chmod.status !== 0) {
    process.exit(chmod.status ?? 1);
  }
  return stagedHelperPath;
}

let stagedHelperPath;
if (process.platform === "darwin") {
  stagedHelperPath = await buildMac();
} else if (process.platform === "win32") {
  stagedHelperPath = await buildWindows();
} else {
  console.error(`[screenshot-helper] no native helper build is defined for platform "${process.platform}"`);
  process.exit(1);
}
const verified = await verifyScreenshotHelper(stagedHelperPath);
console.log(
  `[screenshot-helper] staged ${verified.helperPath} (${verified.size} bytes)`,
);
