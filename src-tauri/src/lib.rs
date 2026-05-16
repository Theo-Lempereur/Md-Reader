// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Listener, Manager};

#[derive(Clone, serde::Serialize)]
struct OpenFilePayload {
    path: String,
    name: String,
    content: String,
}

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

#[cfg(windows)]
mod pdf_export {
    use std::sync::{Arc, Mutex};
    use tauri::webview::PlatformWebview;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_2,
        ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_pdf::core::{Interface, HSTRING};

    pub fn print_to_pdf<F>(
        pv: &PlatformWebview,
        path: &str,
        format: &str,
        on_complete: F,
    ) -> Result<(), String>
    where
        F: FnOnce(Result<(), String>) + Send + 'static,
    {
        let controller = pv.controller();
        unsafe {
            let webview = controller
                .CoreWebView2()
                .map_err(|e| format!("CoreWebView2: {}", e))?;
            let webview7: ICoreWebView2_7 = webview
                .cast()
                .map_err(|e| format!("cast ICoreWebView2_7: {}", e))?;
            let webview2: ICoreWebView2_2 = webview
                .cast()
                .map_err(|e| format!("cast ICoreWebView2_2: {}", e))?;
            let env = webview2
                .Environment()
                .map_err(|e| format!("Environment: {}", e))?;
            let env6: ICoreWebView2Environment6 = env
                .cast()
                .map_err(|e| format!("cast ICoreWebView2Environment6: {}", e))?;

            let settings: ICoreWebView2PrintSettings = env6
                .CreatePrintSettings()
                .map_err(|e| format!("CreatePrintSettings: {}", e))?;

            // Dimensions en pouces. A4 = 210×297 mm, Letter = 8.5×11 in.
            let (page_w, page_h) = match format.to_ascii_lowercase().as_str() {
                "letter" => (8.5_f64, 11.0_f64),
                _ => (8.27_f64, 11.69_f64),
            };
            // Marges : 18 mm verticales (~0.71"), 16 mm horizontales (~0.63").
            settings.SetPageWidth(page_w).ok();
            settings.SetPageHeight(page_h).ok();
            settings.SetMarginTop(0.71).ok();
            settings.SetMarginBottom(0.71).ok();
            settings.SetMarginLeft(0.63).ok();
            settings.SetMarginRight(0.63).ok();
            settings.SetShouldPrintBackgrounds(true).ok();
            settings.SetShouldPrintHeaderAndFooter(false).ok();
            settings.SetScaleFactor(1.0).ok();
            settings
                .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
                .ok();

            let path_hstring = HSTRING::from(path);
            let cb = Arc::new(Mutex::new(Some(on_complete)));
            let cb_inner = cb.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(
                move |error_code, is_successful| {
                    if let Ok(mut guard) = cb_inner.lock() {
                        if let Some(f) = guard.take() {
                            match error_code {
                                Ok(()) if is_successful => f(Ok(())),
                                Ok(()) => f(Err(
                                    "PrintToPdf : opération annulée ou non aboutie."
                                        .to_string(),
                                )),
                                Err(e) => f(Err(format!("PrintToPdf : {}", e))),
                            }
                        }
                    }
                    Ok(())
                },
            ));

            webview7
                .PrintToPdf(&path_hstring, &settings, &handler)
                .map_err(|e| format!("PrintToPdf: {}", e))?;
        }
        Ok(())
    }
}

#[tauri::command]
async fn export_pdf(
    app: tauri::AppHandle,
    path: String,
    format: String,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (app, path, format);
        return Err("Export PDF non supporté sur cette plateforme.".to_string());
    }

    #[cfg(windows)]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Fenêtre principale introuvable.".to_string())?;

        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let tx_for_completion = tx.clone();
        let tx_for_sync_err = tx.clone();

        let path_clone = path.clone();
        let format_clone = format.clone();

        window
            .with_webview(move |platform_webview| {
                let res = pdf_export::print_to_pdf(
                    &platform_webview,
                    &path_clone,
                    &format_clone,
                    move |completion| {
                        if let Ok(mut guard) = tx_for_completion.lock() {
                            if let Some(sender) = guard.take() {
                                let _ = sender.send(completion);
                            }
                        }
                    },
                );
                if let Err(e) = res {
                    if let Ok(mut guard) = tx_for_sync_err.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(Err(e));
                        }
                    }
                }
            })
            .map_err(|e| format!("with_webview: {}", e))?;

        rx.await
            .map_err(|e| format!("oneshot recv: {}", e))?
    }
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

fn resolve_markdown_arg(arg: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let raw = arg.trim_matches('"');
    if raw.is_empty() {
        return None;
    }

    let candidate = PathBuf::from(raw);
    let path = if candidate.is_absolute() {
        candidate
    } else if let Some(cwd) = cwd {
        cwd.join(candidate)
    } else {
        candidate
    };

    if path.is_file() && is_markdown_path(&path) {
        Some(path)
    } else {
        None
    }
}

fn open_file_in_app(app: &tauri::AppHandle, path: PathBuf) {
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document.md".to_string());

    let _ = window.emit(
        "open-file",
        OpenFilePayload {
            path: path.to_string_lossy().into_owned(),
            name,
            content,
        },
    );
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn open_argv_files(app: &tauri::AppHandle, argv: &[String], cwd: Option<&Path>) {
    for arg in argv.iter().skip(1) {
        if let Some(path) = resolve_markdown_arg(arg, cwd) {
            open_file_in_app(app, path);
        }
    }
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_argv_files(app, &argv, Some(Path::new(&cwd)));
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    win_snap::enable(&window);
                }
            }

            let app_handle = app.handle().clone();
            let startup_args: Vec<String> = std::env::args().collect();
            let startup_cwd = std::env::current_dir().ok();
            app.listen("frontend-ready", move |_| {
                open_argv_files(&app_handle, &startup_args, startup_cwd.as_deref());
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            read_text_file,
            write_text_file,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
