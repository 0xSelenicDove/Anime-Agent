const { notarize } = require("@electron/notarize");

/**
 * electron-builder afterSign hook. Notarizes the signed .app with Apple's
 * notary service so Gatekeeper accepts it on a machine without dev tools.
 *
 * Requires APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (an
 * app-specific password from https://appleid.apple.com, not the account
 * password). Missing credentials are a normal case for local/unsigned dev
 * builds, so this skips instead of failing the build.
 */
exports.default = async function notarizeMacApp(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — skipping notarization (unsigned/dev build).");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] submitting ${appName}.app for notarization…`);

  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log(`[notarize] ${appName}.app notarized.`);
};
