//! PNG encoding for macOS.
//!
//! Unlike Windows (WIC via COM), there is no OS imaging framework dependency
//! here at all: the pure-Rust `png` crate encodes directly from a BGRA
//! buffer (after a channel swap — PNG itself only has an RGBA byte order).
//! [`encode_png_bytes`] is synchronous and in-memory, used directly by
//! `mac_app`'s commit path for the clipboard write (every capture mode needs
//! PNG bytes on macOS, since `NSPasteboard` takes a standard image container
//! format rather than a raw DIB the way `win/clipboard.rs` does). The
//! thread-spawn / atomic-rename / registry-finalization shape of
//! [`spawn_encode_job`] mirrors `win/encoder.rs` exactly — that part of the
//! design has no platform dependency at all.

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, mpsc::Sender},
    thread,
};

use png::{BitDepth, ColorType, Encoder};
use uuid::Uuid;

use super::capture::CpuBgraFrame;
use crate::{error::HelperError, protocol::Event, request::RequestRegistry};

/// One async PNG-to-disk encode for a `clipboard-and-file` commit. The
/// worker owns the frame so the UI thread can drop its reference immediately
/// after spawning.
pub struct EncodeJob {
    pub request_id: String,
    pub file_name: String,
    pub output_dir: PathBuf,
    pub frame: CpuBgraFrame,
    pub has_annotations: bool,
}

/// Spawn a worker thread that runs [`run_encode_job`] with `job` and posts
/// the resulting [`Event`] on `event_tx`. See `win/encoder.rs::spawn_encode_job`
/// for the full rationale (detached worker, registry finalization on the
/// worker thread, spawn-failure handling) — identical here.
pub fn spawn_encode_job(
    job: EncodeJob,
    event_tx: Sender<Event>,
    registry: Arc<Mutex<RequestRegistry>>,
) {
    let request_id_for_failure = job.request_id.clone();
    let event_tx_for_worker = event_tx.clone();
    let registry_for_worker = Arc::clone(&registry);
    let spawn_result = thread::Builder::new()
        .name("cyrene-encode".into())
        .spawn(move || {
            let outcome = run_encode_job(&job);
            let event = match outcome {
                Ok(()) => Event::Completed {
                    request_id: job.request_id.clone(),
                    file_name: Some(job.file_name),
                    width: job.frame.width,
                    height: job.frame.height,
                    mime: "image/png",
                    clipboard_written: true,
                    has_annotations: job.has_annotations,
                },
                Err(error) => Event::Error {
                    request_id: Some(job.request_id.clone()),
                    code: "encode-failed".into(),
                    message: error.to_string(),
                    recoverable: false,
                },
            };
            let _ = event_tx_for_worker.send(event);
            finalize_registry(&registry_for_worker, &job.request_id, "complete");
        });
    if let Err(error) = spawn_result {
        let _ = event_tx.send(Event::Error {
            request_id: Some(request_id_for_failure.clone()),
            code: "encode-failed".into(),
            message: format!("failed to spawn encoder: {error}"),
            recoverable: false,
        });
        finalize_registry(&registry, &request_id_for_failure, "cancel");
    }
}

fn finalize_registry(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str, mode: &str) {
    match registry.lock() {
        Ok(mut registry_guard) => {
            let outcome = match mode {
                "complete" => registry_guard.complete(request_id, None),
                _ => registry_guard.cancel(request_id, mode),
            };
            if let Err(error) = outcome {
                eprintln!(
                    "cyrene-screenshot: encoder finalize ({mode}) for {request_id} failed: {error}"
                );
            }
        }
        Err(poison) => {
            eprintln!(
                "cyrene-screenshot: encoder finalize lock unavailable for {request_id}: {poison}"
            );
        }
    }
}

/// Run one encode job to completion. Returns `Ok(())` only when the final
/// `<uuid>.png` exists on disk; any failure removes the partial `.tmp` and
/// returns an error suitable for an `Event::Error` payload.
fn run_encode_job(job: &EncodeJob) -> Result<(), HelperError> {
    if job.frame.width == 0 || job.frame.height == 0 {
        return Err(HelperError::CaptureFailed(
            "encoder received an empty frame".into(),
        ));
    }

    fs::create_dir_all(&job.output_dir).map_err(|error| {
        HelperError::CaptureFailed(format!(
            "create output dir {} failed: {error}",
            job.output_dir.display()
        ))
    })?;

    let tmp_path = job.output_dir.join(format!("{}.tmp", job.file_name));
    let final_path = job.output_dir.join(&job.file_name);

    let encode_result = encode_to_path(&job.frame, &tmp_path);

    match encode_result {
        Ok(()) => {
            if let Err(error) = fs::rename(&tmp_path, &final_path) {
                let _ = fs::remove_file(&tmp_path);
                return Err(HelperError::CaptureFailed(format!(
                    "atomic rename to {} failed: {error}",
                    final_path.display()
                )));
            }
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&tmp_path);
            Err(error)
        }
    }
}

fn encode_to_path(frame: &CpuBgraFrame, path: &std::path::Path) -> Result<(), HelperError> {
    let file = fs::File::create(path)
        .map_err(|error| HelperError::CaptureFailed(format!("create {} failed: {error}", path.display())))?;
    let mut writer = std::io::BufWriter::new(file);
    encode_png_to_writer(frame, &mut writer)?;
    std::io::Write::flush(&mut writer)
        .map_err(|error| HelperError::CaptureFailed(format!("flush {} failed: {error}", path.display())))?;
    Ok(())
}

/// Encode `frame` to PNG bytes in memory. Used directly by `mac_app`'s
/// commit path for the clipboard write, and by [`encode_to_path`] for the
/// `clipboard-and-file` disk write.
pub fn encode_png_bytes(frame: &CpuBgraFrame) -> Result<Vec<u8>, HelperError> {
    let mut buf = Vec::new();
    encode_png_to_writer(frame, &mut buf)?;
    Ok(buf)
}

/// `Writer::finish` consumes the writer without handing the underlying sink
/// back, so callers pass a `&mut W` they already own (a `Vec<u8>` for the
/// in-memory case, a `BufWriter<File>` for the on-disk case) instead of
/// trying to recover ownership afterward.
fn encode_png_to_writer<W: std::io::Write>(frame: &CpuBgraFrame, sink: &mut W) -> Result<(), HelperError> {
    let pitch = frame.width.checked_mul(4).ok_or_else(|| {
        HelperError::EncodeFailed(format!("row size overflow computing width*4 for {}", frame.width))
    })?;
    let expected_bytes = frame.height.checked_mul(pitch).ok_or_else(|| {
        HelperError::EncodeFailed(format!(
            "pixel buffer overflow computing {}*{}",
            frame.height, pitch
        ))
    })? as usize;
    if frame.pitch != pitch || frame.pixels.len() != expected_bytes {
        return Err(HelperError::CaptureFailed(format!(
            "encoder pixel buffer mismatch: len={} pitch={} expected_bytes={expected_bytes} expected_pitch={pitch}",
            frame.pixels.len(),
            frame.pitch,
        )));
    }

    let rgba = bgra_to_rgba(&frame.pixels);

    let mut encoder = Encoder::new(sink, frame.width, frame.height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| HelperError::EncodeFailed(format!("PNG write_header failed: {error}")))?;
    writer
        .write_image_data(&rgba)
        .map_err(|error| HelperError::EncodeFailed(format!("PNG write_image_data failed: {error}")))?;
    writer
        .finish()
        .map_err(|error| HelperError::EncodeFailed(format!("PNG finish failed: {error}")))?;
    Ok(())
}

/// Swap B/R per pixel; alpha and green stay in place. `bytes.len()` must be a
/// multiple of 4 (checked by the caller via the pitch/size validation above).
fn bgra_to_rgba(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    out
}

/// Generate a new `<uuid>.png` file name without the directory.
pub fn new_png_file_name() -> String {
    format!("{}.png", Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_to_rgba_swaps_red_and_blue_only() {
        let bgra = vec![10, 20, 30, 40]; // B=10 G=20 R=30 A=40
        let rgba = bgra_to_rgba(&bgra);
        assert_eq!(rgba, vec![30, 20, 10, 40]);
    }

    #[test]
    fn encode_png_bytes_round_trips_known_pixels() {
        let frame = CpuBgraFrame {
            width: 2,
            height: 1,
            pitch: 8,
            pixels: vec![
                255, 0, 0, 255, // pixel 0: B=255 G=0 R=0 -> red opaque in BGRA
                0, 255, 0, 255, // pixel 1: B=0 G=255 R=0 -> green opaque in BGRA
            ],
        };
        let png_bytes = encode_png_bytes(&frame).expect("encode should succeed");
        assert!(png_bytes.starts_with(&[0x89, b'P', b'N', b'G']));

        let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
        let mut reader = decoder.read_info().expect("valid PNG");
        let mut buf = vec![0u8; reader.output_buffer_size().expect("known output size")];
        let info = reader.next_frame(&mut buf).expect("decode frame");
        let decoded = &buf[..info.buffer_size()];
        // pixel 0 should have decoded back to RGBA red, pixel 1 to RGBA green.
        assert_eq!(&decoded[0..4], &[0, 0, 255, 255]);
        assert_eq!(&decoded[4..8], &[0, 255, 0, 255]);
    }
}
