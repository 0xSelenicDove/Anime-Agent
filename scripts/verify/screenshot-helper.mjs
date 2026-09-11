// Verification helper for the native screenshot executable.
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_HELPER_BYTES = 64 * 1024;

// Mach-O magic numbers, defined by Apple to read the same 4 bytes regardless
// of host byte order — checking both readUInt32BE/LE below covers a file
// whose stored order happens to be the opposite of what a naive single-order
// read would assume.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (thin, 32-bit)
  0xfeedfacf, // MH_MAGIC_64 (thin, 64-bit)
  0xcafebabe, // FAT_MAGIC (universal, 32-bit offsets — what `lipo -create` produces)
  0xcafebabf, // FAT_MAGIC_64 (universal, 64-bit offsets)
]);

export async function verifyScreenshotHelper(inputPath, platform = process.platform) {
  const helperPath = path.resolve(inputPath);
  const metadata = await stat(helperPath);
  if (!metadata.isFile()) {
    throw new Error(`Screenshot helper is not a file: ${helperPath}`);
  }
  if (metadata.size <= MIN_HELPER_BYTES) {
    throw new Error(
      `Screenshot helper is too small (${metadata.size} bytes): ${helperPath}`,
    );
  }

  const file = await open(helperPath, "r");
  try {
    if (platform === "darwin") {
      const header = Buffer.alloc(4);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const magic = bytesRead === 4 ? header.readUInt32BE(0) : 0;
      const magicSwapped = bytesRead === 4 ? header.readUInt32LE(0) : 0;
      if (!MACHO_MAGICS.has(magic) && !MACHO_MAGICS.has(magicSwapped)) {
        throw new Error(`Screenshot helper is not a macOS executable: ${helperPath}`);
      }
    } else {
      const signature = Buffer.alloc(2);
      const { bytesRead } = await file.read(signature, 0, signature.length, 0);
      if (bytesRead !== signature.length || signature.toString("ascii") !== "MZ") {
        throw new Error(`Screenshot helper is not a Windows executable: ${helperPath}`);
      }
    }
  } finally {
    await file.close();
  }

  return { helperPath, size: metadata.size };
}

function defaultHelperPath() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDirectory, "..", "..");
  const name = process.platform === "darwin" ? "cyrene-screenshot" : "cyrene-screenshot.exe";
  return path.join(repoRoot, "resources", "bin", name);
}

async function main() {
  const inputPath = process.argv[2] ?? defaultHelperPath();
  const result = await verifyScreenshotHelper(inputPath);
  console.log(
    `[screenshot-helper] verified ${result.helperPath} (${result.size} bytes)`,
  );
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[screenshot-helper] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
