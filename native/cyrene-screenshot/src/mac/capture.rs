//! Capture-on-demand backend for macOS.
//!
//! Unlike Windows (DXGI live-duplication + GDI fallback), macOS has no
//! continuously-refreshed capture path worth keeping warm between `Start`
//! calls, so there is a single backend here, conceptually equivalent in
//! shape to the Windows *GDI* fallback: capture happens synchronously,
//! on demand, at `freeze()` time.
//!
//! `CGDisplayCreateImage` is deprecated in favor of ScreenCaptureKit, but
//! remains fully functional and is far simpler to drive correctly from
//! Rust (synchronous, no delegate/async setup) — see the plan's Phase 1
//! note for the trade-off. A future revision could swap this backend for
//! `SCScreenshotManager`/`SCStream` without changing any caller.

// `CGDisplayCreateImage`/`CGContextDrawImage`/`CGColorSpaceCreateDeviceRGB`
// are deprecated in favor of ScreenCaptureKit / `CGContext::draw_image` /
// `CGColorSpace::new_device_rgb`; kept deliberately per the module doc above.
#![allow(deprecated)]

use std::ffi::c_void;

use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpaceCreateDeviceRGB, CGContextDrawImage, CGDisplayCreateImage,
    CGImage, CGImageAlphaInfo, CGImageByteOrderInfo, CGMainDisplayID,
};

use super::display::DisplayInfo;
use crate::{diagnostics::CaptureDiagnostics, error::HelperError};

/// BGRA pixels for a frozen frame. Pitch is bytes per row; for this backend
/// it is always exactly `width * 4` (we allocate and hand Core Graphics a
/// tightly-packed buffer), unlike GDI's 4-byte-row-aligned DIBs which can
/// exceed `width * 4`.
#[derive(Debug, Clone)]
pub struct CpuBgraFrame {
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub pixels: Vec<u8>,
}

pub struct CgDisplayCapture {
    diagnostics: CaptureDiagnostics,
}

impl Default for CgDisplayCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl CgDisplayCapture {
    pub fn new() -> Self {
        Self {
            diagnostics: CaptureDiagnostics {
                backend: "cgdisplay",
                ..Default::default()
            },
        }
    }

    pub fn name(&self) -> &'static str {
        "cgdisplay"
    }

    /// No-op: there is no continuously-refreshed "latest frame" to pump.
    /// Kept so `mac_app`'s idle loop can call it unconditionally, mirroring
    /// the shape of the Windows loop's idle DXGI-refresh pump.
    pub fn refresh_latest(&mut self) {}

    pub fn recover(&mut self) {
        self.diagnostics.duplication_rebuilds += 1;
    }

    pub fn invalidate(&mut self) {}

    pub fn diagnostics(&self) -> CaptureDiagnostics {
        self.diagnostics
    }

    pub fn record_selection_readback(&mut self) {
        self.diagnostics.selection_cpu_readbacks += 1;
    }

    pub fn freeze(&mut self, display: &DisplayInfo) -> Result<CpuBgraFrame, HelperError> {
        let display_id = CGMainDisplayID();
        let image = CGDisplayCreateImage(display_id)
            .ok_or_else(|| HelperError::CaptureFailed("CGDisplayCreateImage returned null".into()))?;

        let frame = bgra_frame_from_cgimage(&image)?;
        if frame.width != display.bounds.width || frame.height != display.bounds.height {
            eprintln!(
                "cyrene-screenshot: captured image {}x{} does not match queried display bounds {}x{}",
                frame.width, frame.height, display.bounds.width, display.bounds.height
            );
        }
        self.diagnostics.full_frame_cpu_readbacks += 1;
        self.diagnostics.latest_copies += 1;
        Ok(frame)
    }
}

/// Redraw `image` into a bitmap context we allocate ourselves with an
/// explicit, known pixel format, then read that buffer back — rather than
/// trying to interpret `CGDisplayCreateImage`'s own internal pixel layout
/// (which Apple does not contractually guarantee). `CGContextDrawImage`
/// performs any necessary format conversion, so the returned buffer is
/// reliably BGRA regardless of the source image's actual internal format.
fn bgra_frame_from_cgimage(image: &CGImage) -> Result<CpuBgraFrame, HelperError> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0 || height == 0 {
        return Err(HelperError::CaptureFailed(
            "CGDisplayCreateImage returned a zero-sized image".into(),
        ));
    }

    let bytes_per_row = width
        .checked_mul(4)
        .ok_or_else(|| HelperError::CaptureFailed("frame row size overflow".into()))?;
    let total_bytes = bytes_per_row
        .checked_mul(height)
        .ok_or_else(|| HelperError::CaptureFailed("frame size overflow".into()))?;
    let mut pixels = vec![0u8; total_bytes];

    let color_space = CGColorSpaceCreateDeviceRGB().ok_or_else(|| {
        HelperError::CaptureFailed("CGColorSpaceCreateDeviceRGB returned null".into())
    })?;

    // `PremultipliedFirst | Order32Little` is Apple's documented "32-bit
    // BGRA" combination on a little-endian host: the in-memory byte order is
    // blue, green, red, alpha — exactly `CpuBgraFrame`'s convention. Screen
    // content is opaque, so the alpha byte is always 0xFF here regardless of
    // "premultiplied" semantics.
    let bitmap_info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;

    {
        // SAFETY: `pixels` is a live, uniquely-owned buffer of exactly
        // `height * bytes_per_row` bytes for the lifetime of this block;
        // `context` is dropped (ending Core Graphics' use of the pointer)
        // before `pixels` is read below, and nothing else derives a Rust
        // reference into `pixels` while `context` is alive.
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr() as *mut c_void,
                width,
                height,
                8,
                bytes_per_row,
                Some(&color_space),
                bitmap_info,
            )
        }
        .ok_or_else(|| HelperError::CaptureFailed("CGBitmapContextCreate returned null".into()))?;

        let rect = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize {
                width: width as f64,
                height: height as f64,
            },
        };
        // `CGContextDrawImage` draws synchronously and returns only once the
        // write into `context`'s backing buffer (`pixels`) is complete.
        CGContextDrawImage(Some(&context), rect, Some(image));
    }

    Ok(CpuBgraFrame {
        width: width as u32,
        height: height as u32,
        pitch: bytes_per_row as u32,
        pixels,
    })
}
