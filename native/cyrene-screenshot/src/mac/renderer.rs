//! Core Graphics/AppKit-based overlay rendering for macOS.
//!
//! Draws entirely through `NSBezierPath`/`NSColor`/`NSImage` from within
//! `OverlayView`'s `drawRect:` (see `mac/window.rs`) rather than dropping to
//! raw `CGContext` calls — AppKit's own drawing primitives are sufficient
//! and considerably lower-risk to get right than bridging
//! `NSGraphicsContext` to a `CGContextRef` by hand.
//!
//! Toolbar icons are simple line/rect glyphs rather than the Windows
//! renderer's SVG icons — visually different, functionally equivalent (see
//! the plan's Phase 2 note on this trade-off).
//!
//! [`extract_selection`], [`burn_annotations`] and their pixel-blending
//! helpers are pure pixel math ported directly from `win/renderer.rs` — that
//! file's `CpuBgraFrame` and this module's are structurally identical, so
//! the algorithm carries over unchanged.

#![allow(deprecated)]

use objc2::AnyThread;
use objc2_app_kit::{NSBezierPath, NSColor, NSImage};
use objc2_core_graphics::{
    CGColorSpaceCreateDeviceRGB, CGDataProvider, CGImage as CGImageObj, CGImageAlphaInfo,
    CGImageByteOrderInfo,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use crate::geometry::{AnnotationColor, AnnotationTool, Mark, PointI, RectI, place_toolbar};

use super::capture::CpuBgraFrame;
use super::display::DisplayInfo;
use crate::error::HelperError;

pub const TOOLBAR_WIDTH: u32 = 232;
pub const TOOLBAR_HEIGHT: u32 = 40;
pub const TOOLBAR_GAP: u32 = 8;
pub const TOOLBAR_BUTTON_GAP: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolbarLayout {
    pub toolbar: RectI,
    pub rectangle: RectI,
    pub arrow: RectI,
    pub undo: RectI,
    pub confirm: RectI,
    pub cancel: RectI,
    pub colors: [RectI; 4],
}

/// Compute toolbar button placement for a selection inside `display`. Ported
/// from `win/renderer.rs::compute_toolbar` — pure geometry, no platform
/// dependency beyond `DisplayInfo`'s shape.
pub fn compute_toolbar(selection: RectI, display: &DisplayInfo) -> Option<ToolbarLayout> {
    let local_display = RectI {
        x: 0,
        y: 0,
        width: display.bounds.width,
        height: display.bounds.height,
    };
    let toolbar = place_toolbar(
        selection,
        local_display,
        TOOLBAR_WIDTH,
        TOOLBAR_HEIGHT,
        TOOLBAR_GAP,
    )?;
    let button_width = 40;
    if toolbar.width < button_width * 5 + TOOLBAR_BUTTON_GAP * 4 {
        return None;
    }
    let button = |index: u32| RectI {
        x: toolbar
            .x
            .saturating_add_unsigned(index * (button_width + TOOLBAR_BUTTON_GAP)),
        y: toolbar.y,
        width: button_width,
        height: toolbar.height,
    };
    let rectangle = button(0);
    let arrow = button(1);
    let undo = button(2);
    let cancel = button(3);
    let confirm = button(4);
    let color_size = 28;
    let color_gap = 6;
    let colors_width = color_size * 4 + color_gap * 3;
    let desired_color_x = toolbar.x
        + i32::try_from((toolbar.width.saturating_sub(colors_width)) / 2).unwrap_or_default();
    let color_y = if toolbar.y >= i32::try_from(color_size + color_gap).unwrap_or_default() {
        toolbar.y - i32::try_from(color_size + color_gap).unwrap_or_default()
    } else {
        toolbar
            .y
            .saturating_add_unsigned(toolbar.height + color_gap)
    };
    let colors = std::array::from_fn(|index| RectI {
        x: desired_color_x.saturating_add_unsigned(
            u32::try_from(index).unwrap_or_default() * (color_size + color_gap),
        ),
        y: color_y,
        width: color_size,
        height: color_size,
    });
    Some(ToolbarLayout {
        toolbar,
        rectangle,
        arrow,
        undo,
        confirm,
        cancel,
        colors,
    })
}

/// Crop `frame` to `rect` (display-local pixel coordinates). The returned
/// frame owns its own buffer.
pub fn extract_selection(frame: &CpuBgraFrame, rect: RectI) -> Result<CpuBgraFrame, HelperError> {
    if rect.width == 0 || rect.height == 0 {
        return Err(HelperError::CaptureFailed(
            "extract_selection called with zero-sized rect".into(),
        ));
    }
    if rect.x < 0 || rect.y < 0 {
        return Err(HelperError::CaptureFailed(format!(
            "selection origin ({},{}) must be non-negative",
            rect.x, rect.y
        )));
    }
    let right = (rect.x as i64) + (rect.width as i64);
    let bottom = (rect.y as i64) + (rect.height as i64);
    if right > frame.width as i64 || bottom > frame.height as i64 {
        return Err(HelperError::CaptureFailed(format!(
            "selection {rect:?} exceeds frozen frame {}x{}",
            frame.width, frame.height
        )));
    }

    let dst_pitch = rect.width * 4;
    let mut pixels = vec![0u8; (dst_pitch as usize) * (rect.height as usize)];
    for row in 0..rect.height {
        let src_y = rect.y as u32 + row;
        let src_offset = (src_y as usize) * (frame.pitch as usize) + (rect.x as usize) * 4;
        let dst_offset = (row as usize) * (dst_pitch as usize);
        let row_bytes = (rect.width as usize) * 4;
        pixels[dst_offset..dst_offset + row_bytes]
            .copy_from_slice(&frame.pixels[src_offset..src_offset + row_bytes]);
    }

    Ok(CpuBgraFrame {
        width: rect.width,
        height: rect.height,
        pitch: dst_pitch,
        pixels,
    })
}

/// Rasterize annotation marks permanently into `frame`'s pixels, in
/// `frame`-local coordinates (`selection_origin` is the selection's
/// top-left in the same coordinate space the marks were recorded in).
/// Ported verbatim from `win/renderer.rs::burn_annotations`.
pub fn burn_annotations(frame: &mut CpuBgraFrame, marks: &[Mark], selection_origin: PointI) {
    for mark in marks {
        let (start, end, color, arrow) = match *mark {
            Mark::Rect { start, end, color } => (start, end, color, false),
            Mark::Arrow { start, end, color } => (start, end, color, true),
        };
        let start = (
            start.x.saturating_sub(selection_origin.x),
            start.y.saturating_sub(selection_origin.y),
        );
        let end = (
            end.x.saturating_sub(selection_origin.x),
            end.y.saturating_sub(selection_origin.y),
        );
        let bgra = annotation_bgra(color);
        if arrow {
            draw_bgra_line(frame, start, end, bgra, 3);
            let dx = f64::from(end.0 - start.0);
            let dy = f64::from(end.1 - start.1);
            let length = (dx * dx + dy * dy).sqrt().max(1.0);
            let ux = dx / length;
            let uy = dy / length;
            for side in [-1.0, 1.0] {
                let wing = (
                    (f64::from(end.0) - ux * 12.0 + (-uy) * 6.0 * side).round() as i32,
                    (f64::from(end.1) - uy * 12.0 + ux * 6.0 * side).round() as i32,
                );
                draw_bgra_line(frame, end, wing, bgra, 3);
            }
        } else {
            let left = start.0.min(end.0);
            let top = start.1.min(end.1);
            let right = start.0.max(end.0);
            let bottom = start.1.max(end.1);
            draw_bgra_line(frame, (left, top), (right, top), bgra, 3);
            draw_bgra_line(frame, (right, top), (right, bottom), bgra, 3);
            draw_bgra_line(frame, (right, bottom), (left, bottom), bgra, 3);
            draw_bgra_line(frame, (left, bottom), (left, top), bgra, 3);
        }
    }
}

fn draw_bgra_line(
    frame: &mut CpuBgraFrame,
    start: (i32, i32),
    end: (i32, i32),
    color: [u8; 4],
    thickness: i32,
) {
    let radius = thickness.max(1) as f64 / 2.0;
    let padding = radius.ceil() as i32 + 1;
    let left = start.0.min(end.0).saturating_sub(padding);
    let top = start.1.min(end.1).saturating_sub(padding);
    let right = start.0.max(end.0).saturating_add(padding);
    let bottom = start.1.max(end.1).saturating_add(padding);
    let dx = f64::from(end.0 - start.0);
    let dy = f64::from(end.1 - start.1);
    let length_squared = dx * dx + dy * dy;

    for y in top..=bottom {
        for x in left..=right {
            let px = f64::from(x) + 0.5;
            let py = f64::from(y) + 0.5;
            let t = if length_squared <= f64::EPSILON {
                0.0
            } else {
                (((px - f64::from(start.0)) * dx + (py - f64::from(start.1)) * dy) / length_squared)
                    .clamp(0.0, 1.0)
            };
            let closest_x = f64::from(start.0) + t * dx;
            let closest_y = f64::from(start.1) + t * dy;
            let distance = ((px - closest_x).powi(2) + (py - closest_y).powi(2)).sqrt();
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            if coverage > 0.0 {
                blend_bgra_pixel(frame, x, y, color, coverage);
            }
        }
    }
}

fn blend_bgra_pixel(frame: &mut CpuBgraFrame, x: i32, y: i32, color: [u8; 4], coverage: f64) {
    if x < 0 || y < 0 || x >= frame.width as i32 || y >= frame.height as i32 {
        return;
    }
    let offset = usize::try_from(y).unwrap_or_default() * frame.pitch as usize
        + usize::try_from(x).unwrap_or_default() * 4;
    if let Some(pixel) = frame.pixels.get_mut(offset..offset + 4) {
        let source_alpha = (f64::from(color[3]) / 255.0) * coverage;
        let inverse = 1.0 - source_alpha;
        for channel in 0..3 {
            pixel[channel] = (f64::from(color[channel]) * source_alpha
                + f64::from(pixel[channel]) * inverse)
                .round() as u8;
        }
        pixel[3] = 0xff;
    }
}

fn annotation_bgra(color: AnnotationColor) -> [u8; 4] {
    match color {
        AnnotationColor::Red => [0x4f, 0x4d, 0xff, 0xff],
        AnnotationColor::Yellow => [0x3b, 0xd4, 0xff, 0xff],
        AnnotationColor::Green => [0x96, 0xea, 0x3e, 0xff],
        AnnotationColor::Blue => [0xff, 0x8d, 0x4c, 0xff],
    }
}

fn dim_regions(width: u32, height: u32, selection: Option<RectI>) -> Vec<RectI> {
    let full = RectI {
        x: 0,
        y: 0,
        width,
        height,
    };
    let Some(selection) = selection.and_then(|selection| {
        let left = i64::from(selection.x).clamp(0, i64::from(width));
        let top = i64::from(selection.y).clamp(0, i64::from(height));
        let right =
            (i64::from(selection.x) + i64::from(selection.width)).clamp(0, i64::from(width));
        let bottom =
            (i64::from(selection.y) + i64::from(selection.height)).clamp(0, i64::from(height));
        (right > left && bottom > top).then_some(RectI {
            x: i32::try_from(left).ok()?,
            y: i32::try_from(top).ok()?,
            width: u32::try_from(right - left).ok()?,
            height: u32::try_from(bottom - top).ok()?,
        })
    }) else {
        return vec![full];
    };

    let right = selection.x.saturating_add_unsigned(selection.width);
    let bottom = selection.y.saturating_add_unsigned(selection.height);
    [
        RectI {
            x: 0,
            y: 0,
            width,
            height: u32::try_from(selection.y).unwrap_or_default(),
        },
        RectI {
            x: 0,
            y: bottom,
            width,
            height: height.saturating_sub(u32::try_from(bottom).unwrap_or(height)),
        },
        RectI {
            x: 0,
            y: selection.y,
            width: u32::try_from(selection.x).unwrap_or_default(),
            height: selection.height,
        },
        RectI {
            x: right,
            y: selection.y,
            width: width.saturating_sub(u32::try_from(right).unwrap_or(width)),
            height: selection.height,
        },
    ]
    .into_iter()
    .filter(|region| region.width > 0 && region.height > 0)
    .collect()
}

/// Build a reusable `NSImage` from a frozen frame, for cheap repeated
/// `drawInRect:` calls from `drawRect:` (built once per capture session, not
/// once per repaint). `size` is in points (pixels / scale).
pub fn frozen_image_from_frame(
    frame: &CpuBgraFrame,
    size: NSSize,
) -> Result<objc2::rc::Retained<NSImage>, HelperError> {
    let cf_data = objc2_core_foundation::CFData::from_bytes(&frame.pixels);
    let provider = CGDataProvider::with_cf_data(Some(&cf_data)).ok_or_else(|| {
        HelperError::PlatformApi("CGDataProvider::with_cf_data returned null".into())
    })?;
    let color_space = CGColorSpaceCreateDeviceRGB().ok_or_else(|| {
        HelperError::PlatformApi("CGColorSpaceCreateDeviceRGB returned null".into())
    })?;
    let bitmap_info = objc2_core_graphics::CGBitmapInfo::from_bits_retain(
        CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0,
    );
    // SAFETY: `decode` is null (use default decode array); `provider` holds
    // exactly `height * pitch` bytes matching the width/height/bytesPerRow
    // triple passed here.
    let cg_image = unsafe {
        CGImageObj::new(
            frame.width as usize,
            frame.height as usize,
            8,
            32,
            frame.pitch as usize,
            Some(&color_space),
            bitmap_info,
            Some(&provider),
            std::ptr::null(),
            false,
            objc2_core_graphics::CGColorRenderingIntent::RenderingIntentDefault,
        )
    }
    .ok_or_else(|| HelperError::PlatformApi("CGImageCreate returned null".into()))?;

    let mtm = objc2_foundation::MainThreadMarker::new().ok_or_else(|| {
        HelperError::PlatformApi("frozen_image_from_frame must run on the main thread".into())
    })?;
    let _ = mtm;
    Ok(NSImage::initWithCGImage_size(NSImage::alloc(), &cg_image, size))
}

/// Everything `drawRect:` needs to render one frame of the overlay. All
/// `RectI`/`PointI` fields are in pixel space (matching `CpuBgraFrame` and
/// `geometry.rs`'s convention); `scale` converts to the point space AppKit
/// drawing operates in.
pub struct PaintState<'a> {
    pub frozen_image: Option<&'a objc2::rc::Retained<NSImage>>,
    pub display_bounds: RectI,
    pub scale: f32,
    pub selection: Option<RectI>,
    pub toolbar: Option<ToolbarLayout>,
    pub marks: &'a [Mark],
    pub draft: Option<Mark>,
    pub show_colors: bool,
    pub tool: Option<AnnotationTool>,
    pub color: AnnotationColor,
}

fn to_ns_rect(rect: RectI, scale: f32) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.x as f64 / scale as f64, rect.y as f64 / scale as f64),
        NSSize::new(
            rect.width as f64 / scale as f64,
            rect.height as f64 / scale as f64,
        ),
    )
}

fn ns_color(rgba: [u8; 4]) -> objc2::rc::Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(
        f64::from(rgba[0]) / 255.0,
        f64::from(rgba[1]) / 255.0,
        f64::from(rgba[2]) / 255.0,
        f64::from(rgba[3]) / 255.0,
    )
}

fn annotation_rgba(color: AnnotationColor) -> [u8; 4] {
    let bgra = annotation_bgra(color);
    [bgra[2], bgra[1], bgra[0], bgra[3]]
}

pub fn paint(state: &PaintState) {
    let scale = state.scale;

    if let Some(image) = state.frozen_image {
        image.drawInRect(to_ns_rect(state.display_bounds, scale));
    }

    for region in dim_regions(state.display_bounds.width, state.display_bounds.height, state.selection) {
        ns_color([0, 0, 0, 120]).setFill();
        NSBezierPath::bezierPathWithRect(to_ns_rect(region, scale)).fill();
    }

    if let Some(selection) = state.selection {
        let path = NSBezierPath::bezierPathWithRect(to_ns_rect(selection, scale));
        path.setLineWidth(2.0);
        ns_color([255, 255, 255, 255]).setStroke();
        path.stroke();

        for point in handle_points(selection) {
            let handle_rect = RectI {
                x: point.x - 5,
                y: point.y - 5,
                width: 10,
                height: 10,
            };
            let handle_path = NSBezierPath::bezierPathWithRect(to_ns_rect(handle_rect, scale));
            ns_color([255, 255, 255, 255]).setFill();
            handle_path.fill();
            ns_color([40, 40, 40, 255]).setStroke();
            handle_path.setLineWidth(1.0);
            handle_path.stroke();
        }
    }

    for mark in state.marks.iter().copied().chain(state.draft) {
        draw_mark(mark, scale);
    }

    if let Some(toolbar) = state.toolbar {
        paint_toolbar(&toolbar, state, scale);
    }
}

fn handle_points(selection: RectI) -> [PointI; 8] {
    let right = selection.x.saturating_add_unsigned(selection.width);
    let bottom = selection.y.saturating_add_unsigned(selection.height);
    let center_x = selection.x + i32::try_from(selection.width / 2).unwrap_or(i32::MAX);
    let center_y = selection.y + i32::try_from(selection.height / 2).unwrap_or(i32::MAX);
    [
        PointI { x: selection.x, y: selection.y },
        PointI { x: center_x, y: selection.y },
        PointI { x: right, y: selection.y },
        PointI { x: right, y: center_y },
        PointI { x: right, y: bottom },
        PointI { x: center_x, y: bottom },
        PointI { x: selection.x, y: bottom },
        PointI { x: selection.x, y: center_y },
    ]
}

fn draw_mark(mark: Mark, scale: f32) {
    let (start, end, color) = match mark {
        Mark::Rect { start, end, color } => (start, end, color),
        Mark::Arrow { start, end, color } => (start, end, color),
    };
    let rgba = annotation_rgba(color);
    ns_color(rgba).setStroke();
    let path = NSBezierPath::bezierPath();
    path.setLineWidth(3.0);
    let to_point = |p: PointI| NSPoint::new(p.x as f64 / scale as f64, p.y as f64 / scale as f64);
    match mark {
        Mark::Rect { .. } => {
            let rect = RectI {
                x: start.x.min(end.x),
                y: start.y.min(end.y),
                width: start.x.abs_diff(end.x),
                height: start.y.abs_diff(end.y),
            };
            path.appendBezierPathWithRect(to_ns_rect(rect, scale));
        }
        Mark::Arrow { .. } => {
            path.moveToPoint(to_point(start));
            path.lineToPoint(to_point(end));
            let dx = f64::from(end.x - start.x);
            let dy = f64::from(end.y - start.y);
            let length = (dx * dx + dy * dy).sqrt().max(1.0);
            let ux = dx / length;
            let uy = dy / length;
            for side in [-1.0, 1.0] {
                let wing_x = f64::from(end.x) - ux * 12.0 + (-uy) * 6.0 * side;
                let wing_y = f64::from(end.y) - uy * 12.0 + ux * 6.0 * side;
                path.moveToPoint(to_point(end));
                path.lineToPoint(NSPoint::new(wing_x / scale as f64, wing_y / scale as f64));
            }
        }
    }
    path.stroke();
}

fn paint_toolbar(toolbar: &ToolbarLayout, state: &PaintState, scale: f32) {
    let background = ns_color([40, 40, 40, 230]);
    background.setFill();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(to_ns_rect(toolbar.toolbar, scale), 8.0, 8.0).fill();

    let button_active = state.tool == Some(AnnotationTool::Rectangle);
    paint_button_rect(toolbar.rectangle, button_active, scale);
    let button_active = state.tool == Some(AnnotationTool::Arrow);
    paint_button_rect(toolbar.arrow, button_active, scale);
    paint_button_glyph(toolbar.undo, scale);
    paint_button_check(toolbar.confirm, scale, true);
    paint_button_check(toolbar.cancel, scale, false);

    if state.show_colors {
        let swatches = [
            AnnotationColor::Red,
            AnnotationColor::Yellow,
            AnnotationColor::Green,
            AnnotationColor::Blue,
        ];
        for (rect, color) in toolbar.colors.iter().zip(swatches) {
            ns_color(annotation_rgba(color)).setFill();
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(to_ns_rect(*rect, scale), 4.0, 4.0).fill();
        }
    }
}

fn paint_button_rect(rect: RectI, active: bool, scale: f32) {
    let bg = if active { [90, 90, 200, 255] } else { [70, 70, 70, 255] };
    ns_color(bg).setFill();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(to_ns_rect(rect, scale), 6.0, 6.0).fill();
    // Icon: a simple inset rectangle outline, standing in for the rectangle
    // annotation tool glyph.
    let inset = RectI {
        x: rect.x + 10,
        y: rect.y + 10,
        width: rect.width.saturating_sub(20),
        height: rect.height.saturating_sub(20),
    };
    ns_color([230, 230, 230, 255]).setStroke();
    let path = NSBezierPath::bezierPathWithRect(to_ns_rect(inset, scale));
    path.setLineWidth(2.0);
    path.stroke();
}

fn paint_button_glyph(rect: RectI, scale: f32) {
    ns_color([70, 70, 70, 255]).setFill();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(to_ns_rect(rect, scale), 6.0, 6.0).fill();
    // Icon: a curved-looking undo arrow, approximated with two line segments.
    let cx = rect.x + rect.width as i32 / 2;
    let cy = rect.y + rect.height as i32 / 2;
    ns_color([230, 230, 230, 255]).setStroke();
    let path = NSBezierPath::bezierPath();
    path.setLineWidth(2.0);
    let p = |x: i32, y: i32| NSPoint::new(x as f64 / scale as f64, y as f64 / scale as f64);
    path.moveToPoint(p(cx + 6, cy - 6));
    path.lineToPoint(p(cx - 6, cy));
    path.lineToPoint(p(cx + 6, cy + 6));
    path.stroke();
}

fn paint_button_check(rect: RectI, scale: f32, confirm: bool) {
    let bg = if confirm { [70, 160, 90, 255] } else { [160, 70, 70, 255] };
    ns_color(bg).setFill();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(to_ns_rect(rect, scale), 6.0, 6.0).fill();
    let cx = rect.x + rect.width as i32 / 2;
    let cy = rect.y + rect.height as i32 / 2;
    ns_color([255, 255, 255, 255]).setStroke();
    let path = NSBezierPath::bezierPath();
    path.setLineWidth(2.0);
    let p = |x: i32, y: i32| NSPoint::new(x as f64 / scale as f64, y as f64 / scale as f64);
    if confirm {
        path.moveToPoint(p(cx - 7, cy));
        path.lineToPoint(p(cx - 2, cy + 6));
        path.lineToPoint(p(cx + 8, cy - 7));
    } else {
        path.moveToPoint(p(cx - 6, cy - 6));
        path.lineToPoint(p(cx + 6, cy + 6));
        path.moveToPoint(p(cx - 6, cy + 6));
        path.lineToPoint(p(cx + 6, cy - 6));
    }
    path.stroke();
}
