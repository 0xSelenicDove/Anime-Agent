//! Display query for macOS.
//!
//! Mirrors the scope of `win/display.rs`: the helper only ever freezes the
//! *primary* display (multi-monitor capture is out of scope), so this module
//! exposes a single [`query_primary_display`] entry point.

use objc2::MainThreadMarker;
use objc2_app_kit::NSScreen;
use objc2_core_graphics::{CGDisplayBounds, CGDisplayRotation, CGMainDisplayID};

use crate::{error::HelperError, geometry::DisplayRotation};

/// Physical-pixel bounds, points-to-pixels scale, rotation, and primary flag
/// for the display the helper should freeze.
///
/// Unlike the Windows `DisplayInfo` (which is DPI-aware Win32 physical
/// pixels throughout), macOS's own APIs are natively point-based: `bounds`
/// here is the point-space `CGDisplayBounds` scaled up by `scale`
/// (`NSScreen.backingScaleFactor`) into the same physical-pixel space that
/// `CGDisplayCreateImage` captures and that all `geometry.rs` `RectI` math
/// operates in. Any code that consumes an `NSEvent` location or draws with a
/// layer-backed `NSView`'s auto-scaled `CGContext` (both of which are
/// point-space) must convert through `scale` at that boundary — see
/// `mac/window.rs` and `mac/renderer.rs`.
#[derive(Debug, Clone, Copy)]
pub struct DisplayInfo {
    pub bounds: crate::geometry::RectI,
    pub scale: f32,
    /// Tracked for parity with the Windows `DisplayInfo` and surfaced for
    /// diagnostics; macOS composites a rotated display's framebuffer before
    /// any capture API (including `CGDisplayCreateImage`) observes it, so —
    /// unlike GDI's physical-panel capture on Windows — capture output does
    /// not need a matching manual rotation transform. See `mac/capture.rs`.
    pub rotation: DisplayRotation,
    pub is_primary: bool,
}

pub fn query_primary_display() -> Result<DisplayInfo, HelperError> {
    let mtm = MainThreadMarker::new().ok_or_else(|| {
        HelperError::DisplayQueryFailed("query_primary_display must run on the main thread".into())
    })?;
    let screen = NSScreen::mainScreen(mtm).ok_or_else(|| {
        HelperError::DisplayQueryFailed("NSScreen.mainScreen() returned nil".into())
    })?;
    let scale = screen.backingScaleFactor() as f32;
    if !(scale.is_finite() && scale > 0.0) {
        return Err(HelperError::InvalidDisplay(format!(
            "backingScaleFactor was not a positive finite value: {scale}"
        )));
    }

    let display_id = CGMainDisplayID();
    let bounds_points = CGDisplayBounds(display_id);
    // The main display's origin is always (0, 0) in the global display
    // coordinate space (Apple's documented invariant), so we only need to
    // scale the size, not translate a nonzero origin.
    let width_px = (bounds_points.size.width * scale as f64).round();
    let height_px = (bounds_points.size.height * scale as f64).round();
    if !(width_px.is_finite() && width_px > 0.0 && height_px.is_finite() && height_px > 0.0) {
        return Err(HelperError::InvalidDisplay(format!(
            "CGDisplayBounds reported a non-positive size: {:?}",
            bounds_points.size
        )));
    }

    let rotation_degrees = CGDisplayRotation(display_id);

    Ok(DisplayInfo {
        bounds: crate::geometry::RectI {
            x: 0,
            y: 0,
            width: width_px as u32,
            height: height_px as u32,
        },
        scale,
        rotation: rotation_from_degrees(rotation_degrees),
        is_primary: true,
    })
}

/// `CGDisplayRotation` returns degrees (0/90/180/270), or a negative value
/// when the display doesn't support the query — treat that, and any other
/// unrecognized value, as `Identity` rather than failing the whole request.
fn rotation_from_degrees(degrees: f64) -> DisplayRotation {
    if (degrees - 90.0).abs() < 0.5 {
        DisplayRotation::Rotate90
    } else if (degrees - 180.0).abs() < 0.5 {
        DisplayRotation::Rotate180
    } else if (degrees - 270.0).abs() < 0.5 {
        DisplayRotation::Rotate270
    } else {
        DisplayRotation::Identity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_from_degrees_maps_known_angles() {
        assert_eq!(rotation_from_degrees(0.0), DisplayRotation::Identity);
        assert_eq!(rotation_from_degrees(90.0), DisplayRotation::Rotate90);
        assert_eq!(rotation_from_degrees(180.0), DisplayRotation::Rotate180);
        assert_eq!(rotation_from_degrees(270.0), DisplayRotation::Rotate270);
        assert_eq!(rotation_from_degrees(-1.0), DisplayRotation::Identity);
    }

    // `query_primary_display` itself needs a live main thread + attached
    // display, so it is exercised by `tests/display_smoke.rs` (Phase 5)
    // rather than here.
}
