use std::borrow::Cow;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Manager};

/// JPEG quality for screenshot encoding (balance between file size and quality).
const SCREENSHOT_JPEG_QUALITY: u8 = 80;

#[tauri::command]
pub fn copy_whiteboard(data_url: String) -> Result<(), String> {
    let (_, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid data URL".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode whiteboard image: {}", e))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode whiteboard PNG: {}", e))?
        .to_rgba8();

    let mut cb = arboard::Clipboard::new().map_err(|e| format!("{}", e))?;
    cb.set_image(arboard::ImageData {
        width: image.width() as usize,
        height: image.height() as usize,
        bytes: Cow::Owned(image.into_raw()),
    })
    .map_err(|e| format!("{}", e))?;
    Ok(())
}

/// Hide / exclude the independent toolbar window so it does not appear in the
/// clipboard screenshot, then restore it afterward.
fn with_toolbar_excluded_from_capture<R>(app: &AppHandle, capture: impl FnOnce() -> R) -> R {
    let Some(toolbar) = app.get_webview_window("toolbar") else {
        return capture();
    };
    if !toolbar.is_visible().unwrap_or(false) {
        return capture();
    }

    #[cfg(windows)]
    let affinity_applied = toolbar
        .hwnd()
        .ok()
        .is_some_and(|hwnd| crate::win32::set_window_exclude_from_capture(hwnd.0 as isize, true));

    #[cfg(target_os = "macos")]
    {
        // Sync AppKit orderOut — Tauri hide() is async and races with screencapture.
        crate::macos::hide_toolbar_ns_window_for_capture(&toolbar);
        // Brief settle for the compositor after orderOut.
        std::thread::sleep(Duration::from_millis(32));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Hide so capture never includes the toolbar. On Windows, display-affinity
        // above also covers the brief compositor race between hide() and BitBlt.
        toolbar.hide().ok();
        std::thread::sleep(Duration::from_millis(64));
    }

    let result = capture();
    crate::set_toolbar_window_visible(app, true);

    #[cfg(windows)]
    if affinity_applied {
        if let Ok(hwnd) = toolbar.hwnd() {
            let _ = crate::win32::set_window_exclude_from_capture(hwnd.0 as isize, false);
        }
    }

    result
}

#[tauri::command]
pub fn copy_screen(app: AppHandle) -> Result<(), String> {
    with_toolbar_excluded_from_capture(&app, copy_screen_inner)
}

#[cfg(target_os = "windows")]
fn copy_screen_inner() -> Result<(), String> {
    use crate::win32::*;

    #[allow(clippy::upper_case_acronyms)]
    #[repr(C)]
    struct BITMAPINFOHEADER {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }
    #[allow(clippy::upper_case_acronyms)]
    #[repr(C)]
    struct BITMAPINFO {
        header: BITMAPINFOHEADER,
        _colors: [u32; 1],
    }

    const SRCCOPY: u32 = 0x00CC0020;
    const CF_DIB: u32 = 8;
    const GMEM_MOVEABLE: u32 = 0x0002;

    extern "system" {
        fn GetDC(hwnd: isize) -> isize;
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn CreateCompatibleBitmap(hdc: isize, w: i32, h: i32) -> isize;
        fn SelectObject(hdc: isize, h: isize) -> isize;
        fn BitBlt(
            dst: isize,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            src: isize,
            sx: i32,
            sy: i32,
            rop: u32,
        ) -> i32;
        fn GetDIBits(
            hdc: isize,
            hbm: isize,
            start: u32,
            lines: u32,
            bits: *mut u8,
            bmi: *mut BITMAPINFO,
            usage: u32,
        ) -> i32;
        fn DeleteObject(h: isize) -> i32;
        fn DeleteDC(hdc: isize) -> i32;
        fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
        fn OpenClipboard(hwnd: isize) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, data: isize) -> isize;
        fn CloseClipboard() -> i32;
        fn GlobalAlloc(flags: u32, size: usize) -> isize;
        fn GlobalLock(hmem: isize) -> *mut u8;
        fn GlobalUnlock(hmem: isize) -> i32;
        fn GlobalFree(hmem: isize) -> isize;
    }

    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return Err("Failed to get cursor position".into());
        }
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if hmon == 0 {
            return Err("No monitor found".into());
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cb_size = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut mi) == 0 {
            return Err("Failed to get monitor info".into());
        }
        let rc = &mi.rc_monitor;
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;

        let hdc_screen = GetDC(0);
        if hdc_screen == 0 {
            return Err("Failed to get screen DC".into());
        }
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbm = CreateCompatibleBitmap(hdc_screen, w, h);
        let old_obj = SelectObject(hdc_mem, hbm);
        BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, rc.left, rc.top, SRCCOPY);

        let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
        let pixel_bytes = (w as usize) * (h as usize) * 4;
        let total = header_size + pixel_bytes;

        let hmem = GlobalAlloc(GMEM_MOVEABLE, total);
        if hmem == 0 {
            SelectObject(hdc_mem, old_obj);
            DeleteObject(hbm);
            DeleteDC(hdc_mem);
            ReleaseDC(0, hdc_screen);
            return Err("GlobalAlloc failed".into());
        }
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            GlobalFree(hmem);
            SelectObject(hdc_mem, old_obj);
            DeleteObject(hbm);
            DeleteDC(hdc_mem);
            ReleaseDC(0, hdc_screen);
            return Err("GlobalLock failed".into());
        }

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.header.bi_size = header_size as u32;
        bmi.header.bi_width = w;
        bmi.header.bi_height = h;
        bmi.header.bi_planes = 1;
        bmi.header.bi_bit_count = 32;

        let scan_lines = GetDIBits(hdc_mem, hbm, 0, h as u32, ptr.add(header_size), &mut bmi, 0);

        if scan_lines == 0 {
            GlobalUnlock(hmem);
            GlobalFree(hmem);
            SelectObject(hdc_mem, old_obj);
            DeleteObject(hbm);
            DeleteDC(hdc_mem);
            ReleaseDC(0, hdc_screen);
            return Err("GetDIBits failed: no scan lines copied".into());
        }

        std::ptr::copy_nonoverlapping(&bmi.header as *const _ as *const u8, ptr, header_size);
        GlobalUnlock(hmem);

        if OpenClipboard(0) == 0 {
            GlobalFree(hmem);
            SelectObject(hdc_mem, old_obj);
            DeleteObject(hbm);
            DeleteDC(hdc_mem);
            ReleaseDC(0, hdc_screen);
            return Err("OpenClipboard failed".into());
        }
        EmptyClipboard();
        let result = SetClipboardData(CF_DIB, hmem);
        CloseClipboard();
        if result == 0 {
            GlobalFree(hmem);
        }

        SelectObject(hdc_mem, old_obj);
        DeleteObject(hbm);
        DeleteDC(hdc_mem);
        ReleaseDC(0, hdc_screen);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_screen_inner() -> Result<(), String> {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    let cursor_pos: Option<(i32, i32)> = unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            None
        } else {
            let pt = CGEventGetLocation(event);
            CFRelease(event);
            Some((pt.x as i32, pt.y as i32))
        }
    };

    let monitor = cursor_pos.and_then(|(x, y)| xcap::Monitor::from_point(x, y).ok());
    let monitor = match monitor {
        Some(m) => m,
        None => xcap::Monitor::all()
            .map_err(|e| format!("{}", e))?
            .into_iter()
            .next()
            .ok_or_else(|| "No monitor found".to_string())?,
    };

    let x = monitor.x().map_err(|e| format!("{}", e))?;
    let y = monitor.y().map_err(|e| format!("{}", e))?;
    let w = monitor.width().map_err(|e| format!("{}", e))?;
    let h = monitor.height().map_err(|e| format!("{}", e))?;
    let region = format!("{},{},{},{}", x, y, w, h);
    let status = std::process::Command::new("screencapture")
        .args(["-c", "-x", "-R", &region])
        .status()
        .map_err(|e| format!("screencapture failed: {}", e))?;

    if !status.success() {
        return Err(format!(
            "screencapture exited with code {:?}",
            status.code()
        ));
    }
    Ok(())
}

// ---------- Screen capture for mobile mirror (JPEG data URL) ----------

/// Exclude both the toolbar and overlay windows from screen capture, then restore.
/// This ensures the screenshot shows only the underlying desktop content,
/// not MarkerOn's own annotation overlay or toolbar.
fn with_overlay_and_toolbar_excluded_from_capture<R>(
    app: &AppHandle,
    capture: impl FnOnce() -> R,
) -> R {
    let labels = ["toolbar", "overlay"];
    let mut hidden_windows: Vec<&str> = Vec::new();
    #[cfg(windows)]
    let mut affinity_handles: Vec<isize> = Vec::new();

    for label in &labels {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }

        #[cfg(windows)]
        {
            if let Ok(hwnd) = win.hwnd() {
                if crate::win32::set_window_exclude_from_capture(hwnd.0 as isize, true) {
                    affinity_handles.push(hwnd.0 as isize);
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            crate::macos::hide_toolbar_ns_window_for_capture(&win);
        }

        #[cfg(not(target_os = "macos"))]
        {
            win.hide().ok();
        }

        hidden_windows.push(label);
    }

    // Brief settle for the compositor after hiding / setting display affinity.
    #[cfg(target_os = "macos")]
    std::thread::sleep(Duration::from_millis(32));
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(Duration::from_millis(64));

    let result = capture();

    // Restore visibility for all hidden windows.
    for label in &hidden_windows {
        if *label == "toolbar" {
            crate::set_toolbar_window_visible(app, true);
        } else if *label == "overlay" {
            if let Some(win) = app.get_webview_window("overlay") {
                win.show().ok();
                // Re-assert transparency: some WebView2 builds only apply the
                // clear color once visible after a hide/show cycle.
                crate::overlay::reassert_overlay_transparency(app);
            }
        }
    }

    #[cfg(windows)]
    for hwnd in &affinity_handles {
        let _ = crate::win32::set_window_exclude_from_capture(*hwnd, false);
    }

    result
}

/// Capture the current screen as a JPEG data URL, excluding MarkerOn's own
/// overlay and toolbar windows. Used by the mobile remote to show a screenshot
/// of the desktop beneath the annotations so the user can aim their strokes.
#[tauri::command]
pub fn capture_screen(app: AppHandle) -> Result<String, String> {
    with_overlay_and_toolbar_excluded_from_capture(&app, capture_screen_as_jpeg)
}

/// Encode raw BGRA bottom-up pixel data (Win32 DIB layout) into a JPEG data URL.
/// `bi_height > 0` means the DIB is bottom-up, so we flip rows during conversion.
#[cfg(target_os = "windows")]
fn bgra_to_jpeg_data_url(
    bgra_bottom_up: &[u8],
    width: i32,
    height: i32,
    row_stride: usize,
) -> Result<String, String> {
    use image::ImageEncoder;

    let w = width as usize;
    let h = height as usize;
    if bgra_bottom_up.len() < w * h * 4 {
        return Err("Insufficient pixel data for BGRA → JPEG".into());
    }

    // Build RGB image, flipping vertically (bottom-up → top-down).
    let mut rgb_buf = vec![0u8; w * h * 3];
    for y in 0..h {
        let src_row = (h - 1 - y) * row_stride;
        let dst_row = y * w * 3;
        for x in 0..w {
            let src = src_row + x * 4;
            let dst = dst_row + x * 3;
            // BGRA → RGB
            rgb_buf[dst] = bgra_bottom_up[src + 2]; // R
            rgb_buf[dst + 1] = bgra_bottom_up[src + 1]; // G
            rgb_buf[dst + 2] = bgra_bottom_up[src]; // B
        }
    }

    let mut jpeg_buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        &mut jpeg_buf,
        SCREENSHOT_JPEG_QUALITY,
    );
    encoder
        .write_image(&rgb_buf, w as u32, h as u32, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG encode failed: {}", e))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_buf);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

#[cfg(target_os = "windows")]
fn capture_screen_as_jpeg() -> Result<String, String> {
    use crate::win32::*;

    #[allow(clippy::upper_case_acronyms)]
    #[repr(C)]
    struct BITMAPINFOHEADER {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }
    #[allow(clippy::upper_case_acronyms)]
    #[repr(C)]
    struct BITMAPINFO {
        header: BITMAPINFOHEADER,
        _colors: [u32; 1],
    }

    const SRCCOPY: u32 = 0x00CC0020;

    extern "system" {
        fn GetDC(hwnd: isize) -> isize;
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn CreateCompatibleBitmap(hdc: isize, w: i32, h: i32) -> isize;
        fn SelectObject(hdc: isize, h: isize) -> isize;
        fn BitBlt(
            dst: isize,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            src: isize,
            sx: i32,
            sy: i32,
            rop: u32,
        ) -> i32;
        fn GetDIBits(
            hdc: isize,
            hbm: isize,
            start: u32,
            lines: u32,
            bits: *mut u8,
            bmi: *mut BITMAPINFO,
            usage: u32,
        ) -> i32;
        fn DeleteObject(h: isize) -> i32;
        fn DeleteDC(hdc: isize) -> i32;
        fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
    }

    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return Err("Failed to get cursor position".into());
        }
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if hmon == 0 {
            return Err("No monitor found".into());
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cb_size = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut mi) == 0 {
            return Err("Failed to get monitor info".into());
        }
        let rc = &mi.rc_monitor;
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;

        let hdc_screen = GetDC(0);
        if hdc_screen == 0 {
            return Err("Failed to get screen DC".into());
        }
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbm = CreateCompatibleBitmap(hdc_screen, w, h);
        let old_obj = SelectObject(hdc_mem, hbm);
        BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, rc.left, rc.top, SRCCOPY);

        let row_stride = (w as usize) * 4;
        let pixel_bytes = (w as usize) * (h as usize) * 4;
        let mut pixels = vec![0u8; pixel_bytes];

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.header.bi_size = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.header.bi_width = w;
        bmi.header.bi_height = h; // positive = bottom-up
        bmi.header.bi_planes = 1;
        bmi.header.bi_bit_count = 32;

        let scan_lines = GetDIBits(hdc_mem, hbm, 0, h as u32, pixels.as_mut_ptr(), &mut bmi, 0);

        SelectObject(hdc_mem, old_obj);
        DeleteObject(hbm);
        DeleteDC(hdc_mem);
        ReleaseDC(0, hdc_screen);

        if scan_lines == 0 {
            return Err("GetDIBits failed: no scan lines copied".into());
        }

        bgra_to_jpeg_data_url(&pixels, w, h, row_stride)
    }
}

#[cfg(target_os = "macos")]
fn capture_screen_as_jpeg() -> Result<String, String> {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
        fn CFRelease(cf: *mut std::ffi::c_void);
    }

    let cursor_pos: Option<(i32, i32)> = unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            None
        } else {
            let pt = CGEventGetLocation(event);
            CFRelease(event);
            Some((pt.x as i32, pt.y as i32))
        }
    };

    let monitor = cursor_pos
        .and_then(|(x, y)| xcap::Monitor::from_point(x, y).ok())
        .or_else(|| {
            xcap::Monitor::all()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
        .ok_or_else(|| "No monitor found".to_string())?;

    let image = monitor
        .capture_image()
        .map_err(|e| format!("xcap capture failed: {}", e))?;

    // xcap returns RGBA; convert to RGB for JPEG.
    use image::ImageEncoder;
    let (w, h) = (image.width(), image.height());
    let rgba = image.into_raw();
    let mut rgb_buf = Vec::with_capacity((w as usize) * (h as usize) * 3);
    for chunk in rgba.chunks_exact(4) {
        rgb_buf.push(chunk[0]); // R
        rgb_buf.push(chunk[1]); // G
        rgb_buf.push(chunk[2]); // B
    }

    let mut jpeg_buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        &mut jpeg_buf,
        SCREENSHOT_JPEG_QUALITY,
    );
    encoder
        .write_image(&rgb_buf, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG encode failed: {}", e))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_buf);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}
