//! Manual Phase 2 runtime smoke test (macOS only): captures a real frame,
//! crops a selection out of it, burns an annotation mark into the crop, and
//! encodes the result to PNG — exercising the exact pipeline
//! `mac_app::commit()` runs, without needing the overlay UI or synthetic
//! input at all.
//!
//!   cargo run --example commit_smoke -- /tmp/cyrene-commit-smoke.png

#[cfg(target_os = "macos")]
fn main() {
    use cyrene_screenshot::geometry::{AnnotationColor, Mark, PointI, RectI};
    use cyrene_screenshot::mac::{capture::CgDisplayCapture, display, encoder, permission, renderer};

    let out_path = std::env::args().nth(1).unwrap_or_else(|| "/tmp/cyrene-commit-smoke.png".to_string());

    permission::ensure_screen_recording_access().expect("permission required");
    let disp = display::query_primary_display().expect("query_primary_display failed");
    let mut backend = CgDisplayCapture::new();
    let frame = backend.freeze(&disp).expect("freeze failed");
    println!("captured {}x{}", frame.width, frame.height);

    let selection = RectI { x: 100, y: 100, width: 800, height: 500 };
    let mut cropped = renderer::extract_selection(&frame, selection).expect("extract_selection failed");
    println!("cropped to {}x{}", cropped.width, cropped.height);

    let marks = vec![
        Mark::Rect {
            start: PointI { x: selection.x + 50, y: selection.y + 50 },
            end: PointI { x: selection.x + 300, y: selection.y + 250 },
            color: AnnotationColor::Red,
        },
        Mark::Arrow {
            start: PointI { x: selection.x + 350, y: selection.y + 100 },
            end: PointI { x: selection.x + 600, y: selection.y + 350 },
            color: AnnotationColor::Blue,
        },
    ];
    renderer::burn_annotations(&mut cropped, &marks, PointI { x: selection.x, y: selection.y });

    let png_bytes = encoder::encode_png_bytes(&cropped).expect("encode_png_bytes failed");
    std::fs::write(&out_path, &png_bytes).expect("write failed");
    println!("wrote {} bytes to {out_path}", png_bytes.len());
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("commit_smoke is macOS-only");
}
