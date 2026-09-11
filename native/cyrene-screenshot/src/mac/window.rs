//! macOS overlay window and input state machine.
//!
//! Mirrors `win/window.rs`'s shape and behavior (see that file for the
//! authoritative spec) translated from Win32 HWND/WM_* messages to AppKit
//! NSWindow/NSView/NSEvent. Two differences from the Windows implementation,
//! both documented simplifications for this port (see the plan):
//!
//!   * No "click empty space to select the window under the cursor"
//!     convenience — a plain click with no drag produces no selection here.
//!     Windows' `find_top_level_window_at_point` needs `CGWindowListCopyWindowInfo`
//!     CFDictionary parsing to replicate; left as a follow-up.
//!   * No display-topology-change handling (`WM_DISPLAYCHANGE`/`WM_DPICHANGED`
//!     equivalent) — a capture session assumes a stable display, matching
//!     the "freeze once at Start" model already used for the frozen image.
//!
//! AppKit handles mouse capture automatically (a view that receives
//! `mouseDown:` keeps receiving `mouseDragged:`/`mouseUp:` for that click
//! sequence even if the cursor leaves its bounds), so there is no
//! `SetCapture`/`ReleaseCapture`-equivalent to manage.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{DefinedClass, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSEvent, NSImage, NSView, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSPoint, NSRect};

use crate::geometry::{
    AnnotationColor, AnnotationState, AnnotationTool, Mark, PointI, RectI, SelectionHandle,
    hit_test_selection_handle, resize_selection,
};

use super::display::DisplayInfo;
use super::renderer::{self, PaintState, ToolbarLayout};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAction {
    Selected,
    Commit,
    Cancel,
}

#[derive(Debug, Clone, Copy)]
enum InputState {
    Idle,
    Selecting { anchor: PointI },
    Resizing { handle: SelectionHandle, original: RectI },
    Drawing { start: PointI },
    Selected,
}

pub struct WindowState {
    pub display_bounds: RectI,
    pub scale: f32,
    pub selection: Option<RectI>,
    pub toolbar: Option<ToolbarLayout>,
    pub annotations: AnnotationState,
    pub draft: Option<Mark>,
    pub show_colors: bool,
    input: InputState,
    action: Option<OverlayAction>,
    pub frozen_image: Option<Retained<NSImage>>,
}

impl WindowState {
    fn new(display: &DisplayInfo) -> Self {
        Self {
            display_bounds: display.bounds,
            scale: display.scale,
            selection: None,
            toolbar: None,
            annotations: AnnotationState::default(),
            draft: None,
            show_colors: false,
            input: InputState::Idle,
            action: None,
            frozen_image: None,
        }
    }

    fn reset_interaction(&mut self) {
        self.selection = None;
        self.toolbar = None;
        self.annotations = AnnotationState::default();
        self.draft = None;
        self.show_colors = false;
        self.input = InputState::Idle;
        self.action = None;
        self.frozen_image = None;
    }
}

define_class!(
    // SAFETY: NSView has no subclassing requirements beyond overriding the
    // methods below with matching signatures; OverlayView does not implement
    // Drop.
    #[unsafe(super = NSView)]
    #[thread_kind = MainThreadOnly]
    #[ivars = RefCell<WindowState>]
    pub struct OverlayView;

    unsafe impl NSObjectProtocol for OverlayView {}

    impl OverlayView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            // Top-left origin, y-down — matches `RectI`/`geometry.rs`'s
            // convention (and Windows' client-coordinate convention)
            // directly, with no manual Y-flip math anywhere else.
            true
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(isOpaque))]
        fn is_opaque(&self) -> bool {
            true
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty_rect: NSRect) {
            let state = self.ivars().borrow();
            renderer::paint(&PaintState {
                frozen_image: state.frozen_image.as_ref(),
                display_bounds: state.display_bounds,
                scale: state.scale,
                selection: state.selection,
                toolbar: state.toolbar,
                marks: state.annotations.marks(),
                draft: state.draft,
                show_colors: state.show_colors,
                tool: state.annotations.tool,
                color: state.annotations.color,
            });
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let point = self.event_point(event);
            let mut state = self.ivars().borrow_mut();

            if event.clickCount() >= 2
                && state.selection.is_some_and(|selection| contains(selection, point))
            {
                state.action = Some(OverlayAction::Commit);
                return;
            }

            if matches!(state.input, InputState::Selected) {
                if let Some(toolbar) = state.toolbar {
                    if contains(toolbar.rectangle, point) {
                        state.annotations.tool = Some(AnnotationTool::Rectangle);
                        state.show_colors = true;
                        drop(state);
                        self.setNeedsDisplay(true);
                        return;
                    }
                    if contains(toolbar.arrow, point) {
                        state.annotations.tool = Some(AnnotationTool::Arrow);
                        state.show_colors = true;
                        drop(state);
                        self.setNeedsDisplay(true);
                        return;
                    }
                    if contains(toolbar.undo, point) {
                        state.annotations.undo();
                        drop(state);
                        self.setNeedsDisplay(true);
                        return;
                    }
                    if contains(toolbar.confirm, point) {
                        state.action = Some(OverlayAction::Commit);
                        return;
                    }
                    if contains(toolbar.cancel, point) {
                        state.action = Some(OverlayAction::Cancel);
                        return;
                    }
                    if state.show_colors {
                        if let Some(index) = toolbar.colors.iter().position(|rect| contains(*rect, point)) {
                            state.annotations.color = annotation_color(index);
                            state.show_colors = false;
                            drop(state);
                            self.setNeedsDisplay(true);
                            return;
                        }
                    }
                }
                if let Some(selection) = state.selection {
                    if let Some(handle) = hit_test_selection_handle(selection, point, 10) {
                        state.annotations.clear();
                        state.draft = None;
                        state.show_colors = false;
                        state.toolbar = None;
                        state.input = InputState::Resizing { handle, original: selection };
                        return;
                    }
                    if state.annotations.tool.is_some() && contains(selection, point) {
                        state.draft = make_mark(state.annotations.tool, point, point, state.annotations.color);
                        state.input = InputState::Drawing { start: point };
                        return;
                    }
                }
            }

            state.annotations.clear();
            state.draft = None;
            state.show_colors = false;
            state.toolbar = None;
            state.input = InputState::Selecting { anchor: point };
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            let point = self.event_point(event);
            let mut state = self.ivars().borrow_mut();
            let display_bounds = RectI { x: 0, y: 0, width: state.display_bounds.width, height: state.display_bounds.height };
            match state.input {
                InputState::Selecting { anchor } => {
                    state.selection = normalized_rect(anchor, point).filter(|r| r.width > 0 && r.height > 0);
                    state.toolbar = None;
                }
                InputState::Resizing { handle, original } => {
                    if let Some(selection) = resize_selection(original, handle, point, display_bounds, 4) {
                        state.selection = Some(selection);
                    }
                }
                InputState::Drawing { start } => {
                    if let Some(selection) = state.selection {
                        let end = clamp_point_to_rect(point, selection);
                        state.draft = make_mark(state.annotations.tool, start, end, state.annotations.color);
                    }
                }
                InputState::Idle | InputState::Selected => {}
            }
            drop(state);
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            let point = self.event_point(event);
            let mut state = self.ivars().borrow_mut();
            let mut changed = false;
            match state.input {
                InputState::Selecting { anchor } => {
                    let selection = normalized_rect(anchor, point).filter(|r| r.width >= 4 && r.height >= 4);
                    state.selection = selection;
                    if let Some(selection) = selection {
                        state.toolbar = renderer::compute_toolbar(selection, &display_info(&state));
                        state.input = InputState::Selected;
                        state.action = Some(OverlayAction::Selected);
                        changed = true;
                    } else {
                        state.toolbar = None;
                        state.input = InputState::Idle;
                        changed = true;
                    }
                }
                InputState::Resizing { .. } => {
                    if let Some(selection) = state.selection {
                        state.toolbar = renderer::compute_toolbar(selection, &display_info(&state));
                        state.input = InputState::Selected;
                        state.action = Some(OverlayAction::Selected);
                        changed = true;
                    }
                }
                InputState::Drawing { .. } => {
                    if let Some(mark) = state.draft.take() {
                        if mark_size(mark) >= 4 {
                            state.annotations.push(mark);
                        }
                    }
                    state.input = InputState::Selected;
                    changed = true;
                }
                InputState::Idle | InputState::Selected => {}
            }
            drop(state);
            if changed {
                self.setNeedsDisplay(true);
            }
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) {
            let point = self.event_point(event);
            let mut state = self.ivars().borrow_mut();
            if state.toolbar.is_some_and(|toolbar| contains(toolbar.undo, point)) {
                state.annotations.clear();
                state.draft = None;
                drop(state);
                self.setNeedsDisplay(true);
            }
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            const KEY_ESCAPE: u16 = 53;
            const KEY_RETURN: u16 = 36;
            let code = event.keyCode();
            let mut state = self.ivars().borrow_mut();
            if code == KEY_ESCAPE {
                state.action = Some(OverlayAction::Cancel);
                return;
            }
            if code == KEY_RETURN {
                if state.selection.is_some() {
                    state.action = Some(OverlayAction::Commit);
                }
                return;
            }
            let is_undo = event.modifierFlags().contains(objc2_app_kit::NSEventModifierFlags::Command)
                && event
                    .charactersIgnoringModifiers()
                    .is_some_and(|characters| characters.to_string().eq_ignore_ascii_case("z"));
            if is_undo {
                state.annotations.undo();
                state.draft = None;
                drop(state);
                self.setNeedsDisplay(true);
            }
        }
    }
);

impl OverlayView {
    pub fn new(mtm: MainThreadMarker, display: &DisplayInfo) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(RefCell::new(WindowState::new(display)));
        let frame = NSRect::new(
            NSPoint::new(0.0, 0.0),
            objc2_foundation::NSSize::new(
                display.bounds.width as f64 / display.scale as f64,
                display.bounds.height as f64 / display.scale as f64,
            ),
        );
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    fn event_point(&self, event: &NSEvent) -> PointI {
        let window_point = event.locationInWindow();
        let view_point = self.convertPoint_fromView(window_point, None);
        let scale = self.ivars().borrow().scale as f64;
        PointI {
            x: (view_point.x * scale).round() as i32,
            y: (view_point.y * scale).round() as i32,
        }
    }

    pub fn set_display(&self, display: &DisplayInfo) {
        let mut state = self.ivars().borrow_mut();
        state.display_bounds = display.bounds;
        state.scale = display.scale;
    }

    pub fn set_frozen_image(&self, image: Option<Retained<NSImage>>) {
        self.ivars().borrow_mut().frozen_image = image;
    }

    pub fn hide_reset(&self) {
        self.ivars().borrow_mut().reset_interaction();
    }

    pub fn take_action(&self) -> Option<OverlayAction> {
        self.ivars().borrow_mut().action.take()
    }

    /// Test-only forwarders to the private `#[unsafe(method(...))]` event
    /// handlers above (`define_class!` requires those to be plain `fn`, not
    /// `pub fn`). Used by `examples/window_smoke.rs` to drive the input
    /// state machine deterministically via synthetic `NSEvent`s, without
    /// needing real OS-level input injection (which needs Accessibility
    /// permission this session cannot grant itself).
    pub fn test_mouse_down(&self, event: &NSEvent) {
        self.mouse_down(objc2::sel!(mouseDown:), event);
    }
    pub fn test_mouse_dragged(&self, event: &NSEvent) {
        self.mouse_dragged(objc2::sel!(mouseDragged:), event);
    }
    pub fn test_mouse_up(&self, event: &NSEvent) {
        self.mouse_up(objc2::sel!(mouseUp:), event);
    }
    pub fn test_right_mouse_down(&self, event: &NSEvent) {
        self.right_mouse_down(objc2::sel!(rightMouseDown:), event);
    }
    pub fn test_key_down(&self, event: &NSEvent) {
        self.key_down(objc2::sel!(keyDown:), event);
    }
    pub fn toolbar_for_test(&self) -> Option<ToolbarLayout> {
        self.ivars().borrow().toolbar
    }
    pub fn tool_for_test(&self) -> Option<AnnotationTool> {
        self.ivars().borrow().annotations.tool
    }

    pub fn selection(&self) -> Option<RectI> {
        self.ivars().borrow().selection
    }

    pub fn annotations(&self) -> Vec<Mark> {
        self.ivars().borrow().annotations.marks().to_vec()
    }
}

define_class!(
    // SAFETY: NSWindow requires overriding `canBecomeKeyWindow`/
    // `canBecomeMainWindow` for a borderless window to receive keyboard
    // input; OverlayPanel does not implement Drop.
    #[unsafe(super = NSWindow)]
    #[thread_kind = MainThreadOnly]
    pub struct OverlayPanel;

    unsafe impl NSObjectProtocol for OverlayPanel {}

    impl OverlayPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool {
            true
        }
    }
);

impl OverlayPanel {
    pub fn new(mtm: MainThreadMarker, display: &DisplayInfo) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let frame = points_frame(display);
        let window: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithContentRect: frame,
                styleMask: NSWindowStyleMask::Borderless,
                backing: NSBackingStoreType::Buffered,
                defer: false,
            ]
        };
        window.setLevel(objc2_app_kit::NSScreenSaverWindowLevel);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        window.setOpaque(false);
        window.setHasShadow(false);
        window.setAcceptsMouseMovedEvents(true);
        // SAFETY: standard requirement when creating an NSWindow outside a
        // window controller and managing its lifetime manually (matches the
        // objc2 hello_world_app.rs example's documented usage).
        unsafe { window.setReleasedWhenClosed(false) };
        window
    }

    pub fn show(&self, view: &OverlayView, display: &DisplayInfo) {
        self.setFrame_display(points_frame(display), true);
        let mtm = MainThreadMarker::new().expect("show must run on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        self.makeKeyAndOrderFront(None);
        self.orderFrontRegardless();
        app.activate();
        self.makeFirstResponder(Some(view));
        // `setFrame_display`'s forced redisplay only fires from an actual
        // frame change; the frozen image is uploaded via `set_frozen_image`
        // with the frame typically unchanged, so a repaint must be requested
        // explicitly or `drawRect:` never runs again after the initial
        // (image-less) paint at window creation.
        view.setNeedsDisplay(true);
    }

    pub fn hide(&self) {
        self.orderOut(None);
    }
}

fn points_frame(display: &DisplayInfo) -> NSRect {
    NSRect::new(
        NSPoint::new(
            display.bounds.x as f64 / display.scale as f64,
            display.bounds.y as f64 / display.scale as f64,
        ),
        objc2_foundation::NSSize::new(
            display.bounds.width as f64 / display.scale as f64,
            display.bounds.height as f64 / display.scale as f64,
        ),
    )
}

fn display_info(state: &WindowState) -> DisplayInfo {
    DisplayInfo {
        bounds: state.display_bounds,
        scale: state.scale,
        rotation: crate::geometry::DisplayRotation::Identity,
        is_primary: true,
    }
}

fn normalized_rect(a: PointI, b: PointI) -> Option<RectI> {
    let left = a.x.min(b.x);
    let top = a.y.min(b.y);
    let width = u32::try_from((i64::from(a.x) - i64::from(b.x)).abs()).ok()?;
    let height = u32::try_from((i64::from(a.y) - i64::from(b.y)).abs()).ok()?;
    Some(RectI { x: left, y: top, width, height })
}

fn contains(rect: RectI, point: PointI) -> bool {
    i64::from(point.x) >= i64::from(rect.x)
        && i64::from(point.y) >= i64::from(rect.y)
        && i64::from(point.x) < i64::from(rect.x) + i64::from(rect.width)
        && i64::from(point.y) < i64::from(rect.y) + i64::from(rect.height)
}

fn annotation_color(index: usize) -> AnnotationColor {
    match index {
        1 => AnnotationColor::Yellow,
        2 => AnnotationColor::Green,
        3 => AnnotationColor::Blue,
        _ => AnnotationColor::Red,
    }
}

fn make_mark(tool: Option<AnnotationTool>, start: PointI, end: PointI, color: AnnotationColor) -> Option<Mark> {
    match tool {
        Some(AnnotationTool::Rectangle) => Some(Mark::Rect { start, end, color }),
        Some(AnnotationTool::Arrow) => Some(Mark::Arrow { start, end, color }),
        None => None,
    }
}

fn mark_size(mark: Mark) -> i32 {
    let (start, end) = match mark {
        Mark::Rect { start, end, .. } | Mark::Arrow { start, end, .. } => (start, end),
    };
    (start.x - end.x).abs().max((start.y - end.y).abs())
}

fn clamp_point_to_rect(point: PointI, rect: RectI) -> PointI {
    PointI {
        x: point.x.clamp(rect.x, rect.x.saturating_add_unsigned(rect.width)),
        y: point.y.clamp(rect.y, rect.y.saturating_add_unsigned(rect.height)),
    }
}
