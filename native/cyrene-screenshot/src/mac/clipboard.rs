//! Clipboard publishing for macOS.
//!
//! Much simpler than the Windows `CF_DIBV5` path (`win/clipboard.rs`): macOS's
//! `NSPasteboard` accepts a standard image container format directly, so
//! there is no bitfield/bottom-up-row bookkeeping to get right — we just
//! hand it PNG bytes (the same encoding `mac/encoder.rs` produces for the
//! file-commit case).

use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
use objc2_foundation::NSData;

use crate::error::HelperError;

pub fn write_png_to_pasteboard(png_bytes: &[u8]) -> Result<(), HelperError> {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let data = NSData::with_bytes(png_bytes);
    // SAFETY: reading an `extern "C"` static is inherently unsafe per Rust's
    // FFI rules; `NSPasteboardTypePNG` is a framework-provided constant
    // string, always initialized before any Objective-C runtime call can run.
    let png_type = unsafe { NSPasteboardTypePNG };
    if pasteboard.setData_forType(Some(&data), png_type) {
        Ok(())
    } else {
        Err(HelperError::PlatformApi(
            "NSPasteboard setData:forType: returned false".into(),
        ))
    }
}
