//! macOS process entry point and orchestration, mirroring `app.rs`'s
//! `OverlayApp` state machine (same `RequestRegistry`/protocol-event
//! sequencing) against the mac capture/window/renderer modules instead of
//! Win32. See `mac/window.rs`'s module doc for the two documented behavior
//! simplifications versus Windows.
//!
//! The event loop is structurally different from Windows' `PeekMessageW`
//! pump: instead of a custom message loop, `NSApplication::run()` owns the
//! main run loop, and a repeating `NSTimer` (~60Hz) drains the
//! command/event channels and dispatches — see `ipc.rs`'s `MessageTarget`
//! doc for why a real cross-thread wake signal isn't needed here.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, Mutex},
    time::Instant,
};

use objc2::rc::Retained;
use objc2::{DefinedClass, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol, NSTimer};

use crate::{
    cli::CliOptions,
    error::AppError,
    geometry::RectI,
    ipc::{InputGate, MessageTarget, create_runtime_channels, spawn_stdin_reader, spawn_stdout_writer},
    mac::{
        capture::{CgDisplayCapture, CpuBgraFrame},
        clipboard, encoder,
        display::{self, DisplayInfo},
        parent_watch, permission,
        window::{OverlayAction, OverlayPanel, OverlayView},
    },
    protocol::{CaptureMode, Command, Event, InteractionStateEvent, PROTOCOL_VERSION},
    request::RequestRegistry,
};

struct ActiveRequest {
    request_id: String,
    mode: CaptureMode,
    frame: CpuBgraFrame,
}

struct MacOverlayApp {
    display: DisplayInfo,
    panel: Retained<OverlayPanel>,
    view: Retained<OverlayView>,
    capture: CgDisplayCapture,
    requests: Arc<Mutex<RequestRegistry>>,
    output_dir: std::path::PathBuf,
    active: Option<ActiveRequest>,
    command_rx: std::sync::mpsc::Receiver<Command>,
    event_tx: std::sync::mpsc::Sender<Event>,
    input_gate: InputGate,
    input_event_rx: std::sync::mpsc::Receiver<Event>,
}

impl MacOverlayApp {
    /// Returns `false` when a `Shutdown` command was handled and the app
    /// should terminate.
    fn handle_command(&mut self, command: Command) -> bool {
        match command {
            Command::Start { request_id, mode } => {
                if self.active.is_some() {
                    self.send_error(Some(request_id), "busy", "a screenshot interaction is already active", true);
                    return true;
                }
                let mut registry = self.lock_registry();
                if let Err(error) = registry.accept(&request_id, mode) {
                    drop(registry);
                    self.send_error(
                        Some(request_id.clone()),
                        "busy",
                        &format!("request {request_id} is already pending: {error}"),
                        true,
                    );
                    return true;
                }
                drop(registry);

                let freeze_start = Instant::now();

                if let Err(error) = permission::ensure_screen_recording_access() {
                    self.finalize_request(&request_id, "cancel");
                    self.send_error(Some(request_id), error.code(), &error.to_string(), true);
                    return true;
                }

                match display::query_primary_display() {
                    Ok(display) => {
                        self.display = display;
                        self.view.set_display(&self.display);
                    }
                    Err(error) => {
                        self.finalize_request(&request_id, "cancel");
                        self.send_error(Some(request_id), error.code(), &error.to_string(), true);
                        return true;
                    }
                }

                let frame = match self.capture.freeze(&self.display) {
                    Ok(frame) => frame,
                    Err(error) => {
                        self.finalize_request(&request_id, "cancel");
                        self.send_error(Some(request_id), error.code(), &error.to_string(), true);
                        return true;
                    }
                };

                let points_size = objc2_foundation::NSSize::new(
                    self.display.bounds.width as f64 / self.display.scale as f64,
                    self.display.bounds.height as f64 / self.display.scale as f64,
                );
                match crate::mac::renderer::frozen_image_from_frame(&frame, points_size) {
                    Ok(image) => self.view.set_frozen_image(Some(image)),
                    Err(error) => {
                        self.finalize_request(&request_id, "cancel");
                        self.send_error(Some(request_id), error.code(), &error.to_string(), true);
                        return true;
                    }
                }

                self.active = Some(ActiveRequest { request_id: request_id.clone(), mode, frame });
                let _ = self.event_tx.send(Event::Accepted { request_id: request_id.clone() });
                let _ = self.event_tx.send(Event::InteractionState {
                    request_id: request_id.clone(),
                    state: InteractionStateEvent::Selecting,
                });

                self.panel.show(&self.view, &self.display);

                let freeze_duration_ms = freeze_start.elapsed().as_millis() as u64;
                let _ = self.event_tx.send(Event::OverlayVisible {
                    request_id,
                    freeze_duration_ms,
                    diagnostics: self.capture.diagnostics(),
                });
                true
            }
            Command::Cancel { request_id } => {
                if self.active.as_ref().is_some_and(|active| active.request_id == request_id) {
                    self.cancel("electron-cancelled");
                } else if self.registry_is_pending(&request_id) {
                    let _ = self.event_tx.send(Event::Cancelled {
                        request_id: request_id.clone(),
                        reason: "electron-cancelled".into(),
                    });
                    self.finalize_request(&request_id, "cancel");
                } else {
                    let _ = self.event_tx.send(Event::Cancelled { request_id, reason: "no-active-capture".into() });
                }
                true
            }
            Command::Shutdown => false,
        }
    }

    fn process_overlay_action(&mut self, action: OverlayAction) {
        let Some(active) = self.active.as_ref() else { return };
        let request_id = active.request_id.clone();
        match action {
            OverlayAction::Selected => {
                let _ = self.event_tx.send(Event::InteractionState { request_id, state: InteractionStateEvent::Selected });
            }
            OverlayAction::Commit => {
                let _ = self.event_tx.send(Event::InteractionState { request_id, state: InteractionStateEvent::Committing });
                self.commit();
            }
            OverlayAction::Cancel => self.cancel("user-cancelled"),
        }
    }

    fn commit(&mut self) {
        let selection = self.view.selection().unwrap_or(RectI {
            x: 0,
            y: 0,
            width: self.display.bounds.width,
            height: self.display.bounds.height,
        });
        let annotations = self.view.annotations();
        let has_annotations = !annotations.is_empty();

        let Some(active) = self.active.as_ref() else { return };
        let mut frame = match crate::mac::renderer::extract_selection(&active.frame, selection) {
            Ok(frame) => frame,
            Err(error) => {
                self.finish_error(error.code(), &error.to_string(), true);
                return;
            }
        };
        self.capture.record_selection_readback();
        crate::mac::renderer::burn_annotations(
            &mut frame,
            &annotations,
            crate::geometry::PointI { x: selection.x, y: selection.y },
        );
        let selection_width = frame.width;
        let selection_height = frame.height;

        let clipboard_written = match encoder::encode_png_bytes(&frame) {
            Ok(png_bytes) => clipboard::write_png_to_pasteboard(&png_bytes)
                .map(|()| true)
                .unwrap_or_else(|error| {
                    eprintln!("cyrene-screenshot: clipboard write failed: {error}");
                    false
                }),
            Err(error) => {
                eprintln!("cyrene-screenshot: clipboard PNG encode failed: {error}");
                false
            }
        };

        let Some(active) = self.active.take() else { return };
        self.teardown_overlay();

        let _ = self.event_tx.send(Event::CaptureReleased {
            request_id: active.request_id.clone(),
            clipboard_written,
            width: selection_width,
            height: selection_height,
            diagnostics: self.capture.diagnostics(),
        });
        {
            let mut registry = self.lock_registry();
            if let Err(error) = registry.capture_released(&active.request_id, clipboard_written, selection_width, selection_height) {
                eprintln!("cyrene-screenshot: registry capture_released failed: {error}");
            }
        }

        match active.mode {
            CaptureMode::ClipboardOnly => {
                let request_id = active.request_id;
                let _ = self.event_tx.send(Event::Completed {
                    request_id: request_id.clone(),
                    file_name: None,
                    width: selection_width,
                    height: selection_height,
                    mime: "image/png",
                    clipboard_written,
                    has_annotations,
                });
                self.finalize_request(&request_id, "complete");
            }
            CaptureMode::ClipboardAndFile => {
                let file_name = encoder::new_png_file_name();
                let job = encoder::EncodeJob {
                    request_id: active.request_id,
                    file_name,
                    output_dir: self.output_dir.clone(),
                    frame,
                    has_annotations,
                };
                encoder::spawn_encode_job(job, self.event_tx.clone(), Arc::clone(&self.requests));
            }
        }
    }

    fn cancel(&mut self, reason: &str) {
        let Some(active) = self.active.take() else { return };
        self.teardown_overlay();
        let request_id = active.request_id;
        let _ = self.event_tx.send(Event::Cancelled { request_id: request_id.clone(), reason: reason.into() });
        self.finalize_request(&request_id, "cancel");
    }

    fn finish_error(&mut self, code: &str, message: &str, recoverable: bool) {
        let request_id = self.active.take().map(|active| active.request_id);
        self.teardown_overlay();
        if let Some(id) = &request_id {
            self.finalize_request(id, "cancel");
        }
        self.send_error(request_id, code, message, recoverable);
    }

    fn teardown_overlay(&mut self) {
        self.panel.hide();
        self.view.hide_reset();
    }

    fn send_error(&self, request_id: Option<String>, code: &str, message: &str, recoverable: bool) {
        let _ = self.event_tx.send(Event::Error {
            request_id,
            code: code.into(),
            message: message.into(),
            recoverable,
        });
    }

    fn lock_registry(&self) -> std::sync::MutexGuard<'_, RequestRegistry> {
        self.requests.lock().unwrap_or_else(|error| {
            eprintln!("cyrene-screenshot: requests mutex poisoned, recovering");
            error.into_inner()
        })
    }

    fn registry_is_pending(&self, request_id: &str) -> bool {
        self.lock_registry().is_pending(request_id)
    }

    fn finalize_request(&self, request_id: &str, mode: &str) {
        let mut registry = self.lock_registry();
        let outcome = match mode {
            "complete" => registry.complete(request_id, None),
            _ => registry.cancel(request_id, mode),
        };
        if let Err(error) = outcome {
            eprintln!("cyrene-screenshot: requests finalize ({mode}) for {request_id} failed: {error}");
        }
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; Ticker does not
    // implement Drop.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = Rc<RefCell<MacOverlayApp>>]
    struct Ticker;

    unsafe impl NSObjectProtocol for Ticker {}

    impl Ticker {
        #[unsafe(method(timerFired:))]
        fn timer_fired(&self, _timer: &NSTimer) {
            let app_rc = Rc::clone(self.ivars());
            let mut app = app_rc.borrow_mut();
            let batch = app.input_gate.drain_batch(&app.command_rx, &app.input_event_rx, 64);
            for event in batch.events {
                let _ = app.event_tx.send(event);
            }
            let mut shutdown = false;
            for command in batch.commands {
                if !app.handle_command(command) {
                    shutdown = true;
                    break;
                }
            }
            if let Some(action) = app.view.take_action() {
                app.process_overlay_action(action);
            }
            drop(app);
            if shutdown {
                let mtm = MainThreadMarker::new().expect("timerFired runs on the main thread");
                NSApplication::sharedApplication(mtm).terminate(None);
            }
        }
    }
);

impl Ticker {
    fn new(mtm: MainThreadMarker, app: Rc<RefCell<MacOverlayApp>>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(app);
        unsafe { msg_send![super(this), init] }
    }
}

pub fn run(options: CliOptions) -> Result<(), AppError> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| AppError::Runtime("mac_app::run must start on the main thread".into()))?;

    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    let display = display::query_primary_display().map_err(AppError::from)?;
    let view = OverlayView::new(mtm, &display);
    let panel = OverlayPanel::new(mtm, &display);
    panel.setContentView(Some(&view));

    let target = MessageTarget::new();
    let (channels, input_gate, event_rx, input_event_rx) = create_runtime_channels(target);
    let stdout_thread = spawn_stdout_writer(event_rx);
    parent_watch::start(options.parent_pid, target);
    spawn_stdin_reader(target, input_gate.clone());
    channels
        .event_tx
        .send(Event::Ready { protocol_version: PROTOCOL_VERSION })
        .map_err(|_| AppError::Runtime("stdout writer stopped before ready".into()))?;

    let mac_app = Rc::new(RefCell::new(MacOverlayApp {
        display,
        panel,
        view,
        capture: CgDisplayCapture::new(),
        requests: Arc::new(Mutex::new(RequestRegistry::default())),
        output_dir: options.output_dir,
        active: None,
        command_rx: channels.command_rx,
        event_tx: channels.event_tx,
        input_gate,
        input_event_rx,
    }));

    let ticker = Ticker::new(mtm, Rc::clone(&mac_app));
    // ~60Hz poll of the command/event channels; see the module doc for why
    // no real cross-thread wake signal is needed. `NSTimer` keeps a strong
    // reference to `ticker` for as long as it is scheduled, and the timer is
    // never invalidated because this process lives exactly as long as the
    // capture session it serves.
    let _timer: Retained<NSTimer> = unsafe {
        NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
            1.0 / 60.0,
            &ticker,
            sel!(timerFired:),
            None,
            true,
        )
    };

    app.run();

    // `NSApp.terminate` (called from `Ticker::timer_fired` on shutdown) exits
    // the process directly and never returns here in practice; this drop is
    // reached only if `app.run()` returns some other way (e.g. all windows
    // closed without an explicit terminate, which this helper never does).
    drop(stdout_thread);
    Ok(())
}
