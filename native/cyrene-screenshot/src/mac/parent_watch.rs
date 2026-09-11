//! Parent-process watchdog for macOS.
//!
//! Windows uses `WaitForSingleObject` on a `PROCESS_SYNCHRONIZE` handle for
//! an instant, reactive exit notification (`win/../parent_watch.rs`). macOS
//! (POSIX) has no portable non-owner "wait for this PID to exit" primitive
//! without either a `kqueue` `EVFILT_PROC` watch (owner/root-only in the
//! common case, and only reliable for a direct child) or `ptrace`-adjacent
//! privileges — the Electron parent is neither. Polling `kill(pid, 0)` every
//! 500ms is the standard, portable fallback: it costs a syscall twice a
//! second and reacts within half a second of the parent exiting, which is
//! more than adequate for a shutdown safety net.
use std::{thread, time::Duration};

use crate::{WM_APP_SHUTDOWN, ipc::MessageTarget};

const POLL_INTERVAL: Duration = Duration::from_millis(500);

pub fn start(parent_pid: u32, target: MessageTarget) {
    thread::Builder::new()
        .name("cyrene-parent-watch".into())
        .spawn(move || {
            loop {
                thread::sleep(POLL_INTERVAL);
                if !process_is_alive(parent_pid) {
                    let _ = target.post(WM_APP_SHUTDOWN);
                    return;
                }
            }
        })
        .expect("failed to start parent watcher");
}

/// `kill(pid, 0)` sends no signal; it only checks whether the process exists
/// and is signalable by us, returning `0` if so. `ESRCH` means the PID no
/// longer exists; any other errno (e.g. `EPERM` for a PID reused by a
/// different user's process) is treated as "still alive" so we never shut
/// down on an inconclusive check.
fn process_is_alive(pid: u32) -> bool {
    // SAFETY: `kill` with signal 0 performs no action beyond an existence /
    // permission check; `pid` is a plain integer with no aliasing concerns.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 || *libc::__error() != libc::ESRCH }
}
