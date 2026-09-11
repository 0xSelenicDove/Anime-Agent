//! Manual Phase 1 runtime smoke test (macOS only): query the primary
//! display, ensure screen-recording access, capture a frame, and encode it
//! to a PNG on disk. Not part of the automated test suite — run explicitly:
//!
//!   cargo run --example capture_smoke -- /tmp/cyrene-smoke.png
//!
//! The first run will prompt for Screen Recording permission for whatever
//! process launches this (Terminal, by default) — grant it and re-run.

#[cfg(target_os = "macos")]
fn main() {
    use cyrene_screenshot::mac::{capture::CgDisplayCapture, clipboard, display, encoder, permission};

    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/cyrene-smoke.png".to_string());

    permission::ensure_screen_recording_access().expect("screen recording permission required");

    let display = display::query_primary_display().expect("query_primary_display failed");
    println!(
        "display: {}x{} at ({}, {}), scale={}, rotation={:?}, primary={}",
        display.bounds.width,
        display.bounds.height,
        display.bounds.x,
        display.bounds.y,
        display.scale,
        display.rotation,
        display.is_primary
    );

    let mut backend = CgDisplayCapture::new();
    let frame = backend.freeze(&display).expect("freeze failed");
    println!(
        "captured frame: {}x{} pitch={} bytes={} diagnostics={:?}",
        frame.width,
        frame.height,
        frame.pitch,
        frame.pixels.len(),
        backend.diagnostics()
    );

    let png_bytes = encoder::encode_png_bytes(&frame).expect("encode_png_bytes failed");
    std::fs::write(&out_path, &png_bytes).expect("failed to write PNG");
    println!("wrote {} bytes to {out_path}", png_bytes.len());

    clipboard::write_png_to_pasteboard(&png_bytes).expect("write_png_to_pasteboard failed");
    println!("wrote PNG to the general pasteboard");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("capture_smoke is macOS-only");
}
