//! macOS-specific capture and display backend.
//!
//! Mirrors `win/`'s self-contained shape (see `win/mod.rs`), but is a
//! deliberately independent implementation rather than a shared abstraction
//! over `win/` — the two platforms' capture, windowing, and rendering APIs
//! have nothing in common, and `app.rs`/`mac_app.rs` each own their own copy
//! of the orchestration state machine so neither platform's working code is
//! put at risk by the other's changes.
//!
//!   * [`display`] queries the main display's bounds, scale, and rotation.
//!   * [`capture`] implements the shared `CaptureBackend`-shaped trait using
//!     `CGDisplayCreateImage` (capture-on-demand; no live-duplication
//!     backend is needed on macOS).
//!   * [`permission`] checks/requests the screen-recording TCC grant.
//!   * [`clipboard`] publishes a captured frame to `NSPasteboard`.
//!   * [`encoder`] encodes a selection to PNG on a worker thread.
//!   * [`window`] and [`renderer`] implement the overlay window, its input
//!     state machine, and Core Graphics-based painting.
//!   * [`parent_watch`] polls the Electron parent PID for exit.

#![cfg(target_os = "macos")]

pub mod capture;
pub mod clipboard;
pub mod display;
pub mod encoder;
pub mod parent_watch;
pub mod permission;
pub mod renderer;
pub mod window;
