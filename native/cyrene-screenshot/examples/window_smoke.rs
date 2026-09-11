//! Manual Phase 2 runtime smoke test (macOS only): drives `OverlayView`'s
//! input state machine with synthetic `NSEvent`s constructed in-process,
//! rather than real OS-level input injection (which needs Accessibility
//! permission this session cannot grant itself — see the plan). This tests
//! the state machine deterministically; the overlay is also shown on screen
//! so a screenshot can confirm the visual result matches.
//!
//!   cargo run --example window_smoke

#[cfg(target_os = "macos")]
fn main() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
    };
    use objc2_foundation::NSPoint;

    use cyrene_screenshot::mac::{
        capture::CgDisplayCapture,
        display, permission,
        renderer,
        window::{OverlayPanel, OverlayView},
    };

    let mtm = MainThreadMarker::new().expect("must run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    permission::ensure_screen_recording_access().expect("screen recording permission required");
    let disp = display::query_primary_display().expect("query_primary_display failed");
    println!("display: {:?}", disp.bounds);

    let view = OverlayView::new(mtm, &disp);
    let panel = OverlayPanel::new(mtm, &disp);
    panel.setContentView(Some(&view));

    let mut backend = CgDisplayCapture::new();
    let frame = backend.freeze(&disp).expect("freeze failed");
    let points_size = objc2_foundation::NSSize::new(
        disp.bounds.width as f64 / disp.scale as f64,
        disp.bounds.height as f64 / disp.scale as f64,
    );
    let image = renderer::frozen_image_from_frame(&frame, points_size).expect("frozen image failed");
    view.set_frozen_image(Some(image));

    panel.show(&view, &disp);
    let window_number = panel.windowNumber();

    let make_mouse_event = |kind: NSEventType, x: f64, y: f64| -> objc2::rc::Retained<NSEvent> {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            NSPoint::new(x, y),
            NSEventModifierFlags::empty(),
            0.0,
            window_number,
            None,
            0,
            1,
            1.0,
        )
        .expect("failed to construct synthetic NSEvent")
    };

    // Drag-select a 300x200 point region starting at (100,100) in the
    // view's *flipped* (top-left origin) coordinate space. `locationInWindow`
    // is reported in the window's own (non-flipped, bottom-left) base
    // coordinate system, so we must pass window-base-coordinate points here
    // and let `OverlayView::event_point`'s `convertPoint_fromView` do the
    // flip — i.e. window Y = window height in points minus our desired
    // flipped-view Y.
    let window_height_pts = disp.bounds.height as f64 / disp.scale as f64;
    let to_window_y = |flipped_view_y: f64| window_height_pts - flipped_view_y;

    let down = make_mouse_event(NSEventType::LeftMouseDown, 100.0, to_window_y(100.0));
    view.test_mouse_down(&down);

    let drag1 = make_mouse_event(NSEventType::LeftMouseDragged, 400.0, to_window_y(100.0));
    view.test_mouse_dragged(&drag1);
    let drag2 = make_mouse_event(NSEventType::LeftMouseDragged, 400.0, to_window_y(300.0));
    view.test_mouse_dragged(&drag2);

    let up = make_mouse_event(NSEventType::LeftMouseUp, 400.0, to_window_y(300.0));
    view.test_mouse_up(&up);

    let selection = view.selection();
    println!("selection after drag: {selection:?}");
    let action = view.take_action();
    println!("action after drag: {action:?}");

    assert_eq!(
        selection,
        Some(cyrene_screenshot::geometry::RectI {
            x: 200,
            y: 200,
            width: 600,
            height: 400,
        }),
        "selection should match the dragged rectangle scaled to pixel space"
    );
    assert_eq!(
        action,
        Some(cyrene_screenshot::mac::window::OverlayAction::Selected),
        "mouseUp on a valid drag should report Selected"
    );

    println!("PASS: drag-select produced the expected selection and action");

    // Leave the overlay visible with the selection + toolbar drawn so an
    // external `screencapture` can confirm the visual result.
    std::thread::sleep(std::time::Duration::from_millis(2500));

    // Click the "rectangle" annotation tool button, then draw one inside
    // the selection.
    let toolbar = view.toolbar_for_test().expect("toolbar should exist after a selection");
    let rect_button_px = toolbar.rectangle;
    let rect_button_pt_x = (rect_button_px.x + rect_button_px.width as i32 / 2) as f64 / disp.scale as f64;
    let rect_button_pt_y_flipped = (rect_button_px.y + rect_button_px.height as i32 / 2) as f64 / disp.scale as f64;
    let click_toolbar = make_mouse_event(NSEventType::LeftMouseDown, rect_button_pt_x, to_window_y(rect_button_pt_y_flipped));
    view.test_mouse_down(&click_toolbar);
    println!("tool after toolbar click: {:?}", view.tool_for_test());

    let draw_down = make_mouse_event(NSEventType::LeftMouseDown, 150.0, to_window_y(150.0));
    view.test_mouse_down(&draw_down);
    let draw_drag = make_mouse_event(NSEventType::LeftMouseDragged, 300.0, to_window_y(250.0));
    view.test_mouse_dragged(&draw_drag);
    let draw_up = make_mouse_event(NSEventType::LeftMouseUp, 300.0, to_window_y(250.0));
    view.test_mouse_up(&draw_up);
    println!("annotations after draw: {}", view.annotations().len());
    assert_eq!(view.annotations().len(), 1, "drawing inside the selection should record one mark");
    let _ = view.take_action();

    std::thread::sleep(std::time::Duration::from_millis(2500));

    // Escape should cancel.
    let escape = make_key_event(NSEventType::KeyDown, 53);
    view.test_key_down(&escape);
    assert_eq!(view.take_action(), Some(cyrene_screenshot::mac::window::OverlayAction::Cancel));
    println!("PASS: Escape produced Cancel");

    let _ = app;
}

#[cfg(target_os = "macos")]
fn make_key_event(kind: objc2_app_kit::NSEventType, key_code: u16) -> objc2::rc::Retained<objc2_app_kit::NSEvent> {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    use objc2_foundation::{NSPoint, ns_string};
    unsafe {
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags::empty(),
            0.0,
            0,
            None,
            ns_string!(""),
            ns_string!(""),
            false,
            key_code,
        )
    }
    .expect("failed to construct synthetic key NSEvent")
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("window_smoke is macOS-only");
}
