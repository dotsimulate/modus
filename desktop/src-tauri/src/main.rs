#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod job;
mod tailscale;

use std::{
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use backend::{BackendSupervisor, BootstrapRequest, BootstrapResponse};
use serde::Deserialize;
use tailscale::DesktopTailscaleStatus;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WindowEvent,
};

static QUITTING: AtomicBool = AtomicBool::new(false);
static SMOKE_QUIT_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiConnectedRequest {
    backend_id: String,
    port: u16,
}

#[tauri::command]
async fn desktop_bootstrap(
    app: AppHandle,
    supervisor: State<'_, Arc<BackendSupervisor>>,
    mut request: BootstrapRequest,
) -> Result<BootstrapResponse, String> {
    if let Ok(mode) = env::var("MODUS_DESKTOP_MODE") {
        if !mode.trim().is_empty() {
            request.mode = mode.trim().to_string();
            if request.mode == "remote" {
                request.url = env::var("MODUS_DESKTOP_TARGET_URL").ok().or(request.url);
            }
        }
    }
    let supervisor = Arc::clone(supervisor.inner());
    let response = tauri::async_runtime::spawn_blocking(move || supervisor.bootstrap(request))
        .await
        .map_err(|error| format!("desktop bootstrap task failed: {error}"))??;
    schedule_smoke_quit(&app);
    Ok(response)
}

#[tauri::command]
async fn desktop_ui_connected(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    request: UiConnectedRequest,
) -> Result<(), String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || {
        supervisor.mark_ui_connected(&request.backend_id, request.port)
    })
    .await
    .map_err(|error| format!("desktop UI acknowledgement task failed: {error}"))?
}

#[tauri::command]
async fn desktop_tailscale_status(
    supervisor: State<'_, Arc<BackendSupervisor>>,
) -> Result<DesktopTailscaleStatus, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.tailscale_status())
        .await
        .map_err(|error| format!("desktop Tailnet status task failed: {error}"))?
}

#[tauri::command]
async fn desktop_set_tailscale_enabled(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    enabled: bool,
) -> Result<DesktopTailscaleStatus, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.set_tailscale_enabled(enabled))
        .await
        .map_err(|error| format!("desktop Tailnet configuration task failed: {error}"))?
}

#[tauri::command]
fn quit_modus(app: AppHandle) {
    begin_quit(app);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn begin_quit(app: AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let supervisor = Arc::clone(app.state::<Arc<BackendSupervisor>>().inner());
        if let Err(error) = supervisor.stop_owned() {
            eprintln!("[desktop] managed backend shutdown warning: {error}");
        }
        supervisor.clear_runtime_state();
        app.exit(0);
    });
}

fn schedule_smoke_quit(app: &AppHandle) {
    let Ok(value) = env::var("MODUS_DESKTOP_SMOKE_QUIT_MS") else {
        return;
    };
    let Ok(milliseconds) = value.parse::<u64>() else {
        return;
    };
    if milliseconds == 0 || SMOKE_QUIT_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(milliseconds));
        begin_quit(app);
    });
}

fn allow_parallel_smoke_instance() -> bool {
    env::var("MODUS_DESKTOP_SMOKE_ALLOW_PARALLEL").as_deref() == Ok("1")
        && env::var("MODUS_INSTANCE").is_ok_and(|instance| instance.starts_with("packaged-"))
}

fn main() {
    let mut builder = tauri::Builder::default();
    if !allow_parallel_smoke_instance() {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                show_main_window(app);
            },
        ));
    }
    let app = builder
        .invoke_handler(tauri::generate_handler![
            desktop_bootstrap,
            desktop_ui_connected,
            desktop_tailscale_status,
            desktop_set_tailscale_enabled,
            quit_modus
        ])
        .setup(|app| {
            let supervisor =
                BackendSupervisor::new(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(Arc::new(supervisor));

            let show = MenuItem::with_id(app, "show", "Show Modus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Modus", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| std::io::Error::other("desktop icon is missing"))?;
            TrayIconBuilder::with_id("modus-tray")
                .icon(icon)
                .tooltip("Modus · Close keeps local and Tailnet access running; Quit stops both")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => begin_quit(app.clone()),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Modus desktop");

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } if !QUITTING.load(Ordering::SeqCst) => {
            api.prevent_exit();
            begin_quit(app.clone());
        }
        tauri::RunEvent::Exit => {
            let supervisor = Arc::clone(app.state::<Arc<BackendSupervisor>>().inner());
            let _ = supervisor.stop_owned();
            supervisor.clear_runtime_state();
        }
        _ => {}
    });
}
