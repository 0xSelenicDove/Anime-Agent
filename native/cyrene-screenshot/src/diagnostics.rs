//! Capture diagnostics shared by the wire protocol and every platform's
//! capture backend. Lives outside `win`/`mac` because `protocol.rs`'s
//! `Event` needs a single type regardless of which platform backend produced
//! the counters.

/// Counters that prove the capture path is delivering on its promise: no
/// full-screen CPU readback between `Start` and `overlay-visible` on backends
/// that can avoid it, and exactly one selection readback at commit.
///
/// Fields are cumulative monotonic counters exposed on the wire via
/// `Event::OverlayVisible` and `Event::CaptureReleased` so integration tests
/// can assert the documented invariants without a private inspector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDiagnostics {
    /// Stable backend identifier surfaced on the wire (e.g. `"dxgi"`, `"gdi"`, `"cgdisplay"`).
    pub backend: &'static str,
    /// Total operations that pulled a full display-sized buffer back to the
    /// CPU. Backends that keep the frame on the GPU until commit must keep
    /// this at zero between `Start` and `overlay-visible`.
    pub full_frame_cpu_readbacks: u64,
    /// Total operations that pulled the *selection* rectangle (or smaller)
    /// back to the CPU. Every backend increments this at commit.
    pub selection_cpu_readbacks: u64,
    /// Times the backend's notion of "latest frame" was refreshed (DXGI's
    /// `AcquireNextFrame`, or a capture-on-demand backend's first freeze).
    pub latest_copies: u64,
    /// Times backend resources were rebuilt after loss (ACCESS_LOST, display
    /// change, DPI change). Zero on a healthy desktop.
    pub duplication_rebuilds: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_default_is_all_zero() {
        let d = CaptureDiagnostics::default();
        assert_eq!(d.backend, "");
        assert_eq!(d.full_frame_cpu_readbacks, 0);
        assert_eq!(d.selection_cpu_readbacks, 0);
        assert_eq!(d.latest_copies, 0);
        assert_eq!(d.duplication_rebuilds, 0);
    }
}
