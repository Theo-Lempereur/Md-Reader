// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Réactive Aero Snap (drag-to-edge, drag-to-top) avec `decorations: false`.
///
/// Avec `decorations: false`, Tauri/tao retire `WS_THICKFRAME` du style de la
/// fenêtre, ce qui désactive le snap natif Windows. On le réinjecte ici, puis
/// on hook `WM_NCCALCSIZE` pour absorber la zone non-cliente afin que la barre
/// de titre native ne réapparaisse pas visuellement.
///
/// On NE TOUCHE PAS à `WM_NCHITTEST` : nos boutons React restent cliquables et
/// le drag se fait toujours via `data-tauri-drag-region` (qui simule HTCAPTION
/// via `startDragging`, ce qui suffit dès lors que `WS_THICKFRAME` est présent).
#[cfg(windows)]
mod win_snap {
    use std::mem::size_of;
    use tauri::{Runtime, WebviewWindow};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::Controls::MARGINS;
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, NCCALCSIZE_PARAMS,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
        WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCPAINT, WS_THICKFRAME,
    };

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            // Retourner 0 sur WM_NCCALCSIZE (wParam == TRUE) indique à Windows que
            // la zone client occupe tout le rectangle de la fenêtre, supprimant le
            // bord non-client qui réapparaitrait visuellement avec WS_THICKFRAME.
            //
            // Cas maximisé : Windows gonfle le rect de la fenêtre au-delà de la
            // zone de travail pour masquer ses bords (~8px à 100% DPI). Sans
            // bordure native, le contenu déborde hors de l'écran visible. On
            // clippe donc le rect proposé à la zone de travail du moniteur — ça
            // gère maximize, Aero Snap, fullscreen sans dépendre d'un état
            // asynchrone comme WINDOWPLACEMENT.
            WM_NCCALCSIZE if wparam.0 != 0 => {
                let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                if !monitor.is_invalid() {
                    let mut info = MONITORINFO {
                        cbSize: size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    if GetMonitorInfoW(monitor, &mut info).as_bool() {
                        let work = info.rcWork;
                        let rect = &mut params.rgrc[0];
                        if rect.left < work.left {
                            rect.left = work.left;
                        }
                        if rect.top < work.top {
                            rect.top = work.top;
                        }
                        if rect.right > work.right {
                            rect.right = work.right;
                        }
                        if rect.bottom > work.bottom {
                            rect.bottom = work.bottom;
                        }
                    }
                }
                LRESULT(0)
            }
            // Supprime le repaint de la bordure native lors des transitions de
            // focus (active ↔ inactive). Sans ça, Windows redessine brièvement
            // un liseré gris au sommet de la fenêtre.
            WM_NCACTIVATE => LRESULT(1),
            // Supprime tout repaint de la zone non-cliente — la barre custom
            // remplit déjà la totalité du rendu.
            WM_NCPAINT => LRESULT(0),
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    pub fn enable<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(raw_hwnd) = window.hwnd() else {
            return;
        };
        // Le HWND Tauri et le HWND windows-rs partagent la même représentation
        // (pointeur opaque) ; on reconstruit pour absorber les écarts de version.
        let hwnd = HWND(raw_hwnd.0 as _);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style | (WS_THICKFRAME.0 as isize));
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);
            // Étendre la frame DWM avec une marge minimale supprime le liseré
            // natif d'1px qui peut apparaître au sommet d'une fenêtre borderless.
            let margins = MARGINS {
                cxLeftWidth: 0,
                cxRightWidth: 0,
                cyTopHeight: 1,
                cyBottomHeight: 0,
            };
            let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|_app| {
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    win_snap::enable(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            read_text_file,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
