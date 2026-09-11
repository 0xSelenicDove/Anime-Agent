//! Screen-recording (TCC) permission handling.
//!
//! macOS gates `CGDisplayCreateImage` and friends behind a per-bundle-ID TCC
//! grant that the user approves once in System Settings → Privacy & Security
//! → Screen Recording. There is no entitlement or Info.plist key involved
//! (unlike the mic/camera usage-description keys) — see the plan's Phase 1
//! note and `build/entitlements.mac.plist`, which needs no change for this.

use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};

use crate::error::HelperError;

/// Ensure the process holds screen-recording access, prompting the user via
/// the system TCC dialog if it doesn't yet. Returns
/// `Err(HelperError::PermissionDenied)` if the user has not granted access
/// after the prompt (including when the grant was previously and explicitly
/// denied, in which case macOS does not show a prompt at all).
pub fn ensure_screen_recording_access() -> Result<(), HelperError> {
    if CGPreflightScreenCaptureAccess() {
        return Ok(());
    }
    // Triggers the system permission prompt at most once per bundle ID; a
    // prior explicit denial makes this return `false` immediately without
    // showing a prompt.
    if CGRequestScreenCaptureAccess() {
        return Ok(());
    }
    Err(HelperError::PermissionDenied)
}
