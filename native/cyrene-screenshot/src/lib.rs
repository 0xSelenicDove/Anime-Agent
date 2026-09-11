pub mod cli;
pub mod diagnostics;
pub mod error;
pub mod geometry;
pub mod ipc;
pub mod protocol;
pub mod request;

#[cfg(windows)]
pub mod app;
#[cfg(windows)]
pub mod parent_watch;
#[cfg(windows)]
pub mod win;

#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(target_os = "macos")]
pub mod mac_app;

#[cfg(windows)]
pub const WM_APP_COMMAND: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 1;
#[cfg(windows)]
pub const WM_APP_SHUTDOWN: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 2;

// macOS has no reserved "app-defined message" range to respect (the Windows
// values above must stay within WM_APP..0xBFFF) — these are just distinct
// markers passed through `MessageTarget::post` for logging/symmetry. See
// `mac_app.rs` for why the mac event loop does not actually need a real wake
// signal to act on them promptly.
#[cfg(target_os = "macos")]
pub const WM_APP_COMMAND: u32 = 1;
#[cfg(target_os = "macos")]
pub const WM_APP_SHUTDOWN: u32 = 2;
