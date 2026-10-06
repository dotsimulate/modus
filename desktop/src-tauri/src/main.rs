#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod deep_link;
mod file_open;
mod job;
mod media_permission;
mod mini_viewer;
mod opener;
mod tailscale;
mod updates;
mod vaults;

use std::{
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use backend::{BackendSupervisor, BootstrapRequest, BootstrapResponse, DesktopVaultStatus};
use deep_link::{DeepLinkTarget, PendingDeepLink};
use file_open::PendingFiles;
use media_permission::MicrophoneArm;
use mini_viewer::MiniViewer;
use serde::Deserialize;
use tailscale::DesktopTailscaleStatus;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WindowEvent,
};
use updates::{desktop_check_for_update, desktop_install_pending_update, PendingUpdate};
use vaults::{
    VaultListResponse, VaultPolicy, VaultRegistrationRequest, VaultRegistryEntry,
    VaultUpdateRequest,
};

static QUITTING: AtomicBool = AtomicBool::new(false);
static SMOKE_QUIT_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiConnectedRequest {
    backend_id: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultRequest {
    slug: Option<String>,
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
async fn desktop_open_vault(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    request: VaultRequest,
) -> Result<BootstrapResponse, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.ensure_vault(request.slug.as_deref()))
        .await
        .map_err(|error| format!("desktop Vault startup task failed: {error}"))?
}

#[tauri::command]
async fn desktop_vault_status(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    request: VaultRequest,
) -> Result<DesktopVaultStatus, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.vault_status(request.slug.as_deref()))
        .await
        .map_err(|error| format!("desktop Vault status task failed: {error}"))?
}

#[tauri::command]
async fn desktop_list_vaults(
    supervisor: State<'_, Arc<BackendSupervisor>>,
) -> Result<VaultListResponse, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.list_vaults())
        .await
        .map_err(|error| format!("desktop Vault list task failed: {error}"))?
}

#[tauri::command]
async fn desktop_create_vault(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    request: VaultRegistrationRequest,
) -> Result<VaultRegistryEntry, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.create_vault(request))
        .await
        .map_err(|error| format!("desktop Vault create task failed: {error}"))?
}

#[tauri::command]
async fn desktop_repair_vault(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    request: VaultRegistrationRequest,
) -> Result<VaultRegistryEntry, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.repair_vault(request))
        .await
        .map_err(|error| format!("desktop Vault repair task failed: {error}"))?
}

#[tauri::command]
async fn desktop_update_vault(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    slug: String,
    patch: VaultUpdateRequest,
) -> Result<VaultRegistryEntry, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.update_vault(&slug, patch))
        .await
        .map_err(|error| format!("desktop Vault update task failed: {error}"))?
}

#[tauri::command]
async fn desktop_vault_policy(
    supervisor: State<'_, Arc<BackendSupervisor>>,
    request: VaultRequest,
) -> Result<VaultPolicy, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || supervisor.vault_policy(request.slug.as_deref()))
        .await
        .map_err(|error| format!("desktop Vault policy task failed: {error}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickRequest {
    title: Option<String>,
    /// Directory the dialog opens in. Ignored unless it exists.
    initial_path: Option<String>,
    /// Extension allowlist for file picks, e.g. `[".png", ".jpg"]`.
    #[serde(default)]
    accept: Vec<String>,
}

/// A directory the dialog can actually open in.
///
/// The suggestion originates in a text field the user can type anything into,
/// and `set_directory` with a path that does not exist leaves the dialog
/// pointing at an arbitrary default, so it is dropped unless it resolves.
fn existing_directory(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw.map(str::trim).filter(|value| !value.is_empty())?;
    let path = PathBuf::from(trimmed);
    path.is_dir().then_some(path)
}

/// Run the OS folder dialog off the async runtime and return the chosen path.
///
/// `blocking_pick_folder` parks the calling thread until the user answers, so
/// the whole call moves onto a blocking worker.
async fn pick_folder(
    app: AppHandle,
    title: String,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = app.dialog().file().set_title(title);
        if let Some(directory) = existing_directory(initial_path.as_deref()) {
            builder = builder.set_directory(directory);
        }
        let Some(selection) = builder.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|error| format!("selected folder is not a local path: {error}"))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|error| format!("desktop folder picker task failed: {error}"))?
}

#[tauri::command]
async fn desktop_choose_vault_folder(app: AppHandle) -> Result<Option<String>, String> {
    pick_folder(app, "Choose a Modus Vault folder".to_string(), None).await
}

/// Native folder dialog for the harness UI's path fields.
///
/// Only correct when the webview and the harness backend share a filesystem;
/// the UI decides that (`nativePickerAvailable`) and keeps its server-side
/// browser for every other backend target.
#[tauri::command]
async fn desktop_pick_folder(
    app: AppHandle,
    request: PickRequest,
) -> Result<Option<String>, String> {
    let title = request
        .title
        .unwrap_or_else(|| "Select a folder".to_string());
    pick_folder(app, title, request.initial_path).await
}

/// Native file dialog, filtered by the caller's extension allowlist.
///
/// The filter is a convenience only — a move's declared file policy is still
/// re-enforced server-side at activation.
#[tauri::command]
async fn desktop_pick_file(app: AppHandle, request: PickRequest) -> Result<Option<String>, String> {
    let title = request.title.unwrap_or_else(|| "Select a file".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = app.dialog().file().set_title(title);
        if let Some(directory) = existing_directory(request.initial_path.as_deref()) {
            builder = builder.set_directory(directory);
        }
        let extensions: Vec<&str> = request
            .accept
            .iter()
            .map(|value| value.trim().trim_start_matches('.'))
            .filter(|value| !value.is_empty())
            .collect();
        if !extensions.is_empty() {
            builder = builder.add_filter("Allowed files", &extensions);
        }
        let Some(selection) = builder.blocking_pick_file() else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|error| format!("selected file is not a local path: {error}"))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|error| format!("desktop file picker task failed: {error}"))?
}

/// Open a link from rendered content in the system browser.
///
/// Without this the webview navigates itself to the target and the app is gone
/// from the window. Validation lives in [`opener`]; see its module docs for why
/// the scheme allowlist is not a formality.
#[tauri::command]
async fn desktop_open_external_url(url: String) -> Result<(), String> {
    run_opener(move || opener::open_external_url(&url), "url opener").await
}

/// Show a path in the OS file manager, selected in its containing folder.
#[tauri::command]
async fn desktop_reveal_path(path: String) -> Result<(), String> {
    run_opener(move || opener::reveal_local_path(&path), "path reveal").await
}

/// Hand a path to its default program — for a directory, the file manager.
#[tauri::command]
async fn desktop_open_path(path: String) -> Result<(), String> {
    run_opener(move || opener::open_local_path(&path), "path opener").await
}

/// Shell handoff blocks (COM on Windows, a spawned launcher elsewhere), so it
/// runs off the async runtime like the native dialogs above.
async fn run_opener<F>(work: F, label: &str) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("desktop {label} task failed: {error}"))?
}

/// Claim a `modus://` link that arrived before the webview was listening.
///
/// Returns `None` when the app started normally, which is the common case.
#[tauri::command]
fn desktop_take_pending_deep_link(pending: State<'_, PendingDeepLink>) -> Option<DeepLinkTarget> {
    pending.take()
}

#[tauri::command]
fn desktop_take_pending_files(pending: State<'_, PendingFiles>) -> Vec<String> {
    pending.take()
}

#[tauri::command]
fn desktop_has_pending_files(pending: State<'_, PendingFiles>) -> bool {
    pending.has_pending()
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

/// Record that the user just asked to record.
///
/// On Linux the webview does not decide `getUserMedia` itself — it asks this
/// process, and the answer is yes only in the moments after a mic press. See
/// [`media_permission`] for the whole boundary and why a press is the
/// authorization rather than the window being trusted. Harmless on Windows and
/// macOS, where the platform webview never asks and nothing reads this.
#[tauri::command]
fn desktop_arm_microphone(arm: State<'_, Arc<MicrophoneArm>>) {
    arm.arm();
}

#[tauri::command]
fn quit_modus(app: AppHandle) {
    begin_quit(app);
}

#[tauri::command]
fn desktop_show_main_window(app: AppHandle) {
    show_main_window(&app);
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
        && env::var("MODUS_DESKTOP_SMOKE_ID")
            .is_ok_and(|instance| instance.starts_with("packaged-"))
}

fn main() {
    if let Some(exit_code) = backend::maybe_run_backend_launcher() {
        std::process::exit(exit_code);
    }

    let mut builder = tauri::Builder::default();
    if !allow_parallel_smoke_instance() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
            file_open::dispatch_arguments(
                app,
                arguments.into_iter().skip(1).map(Into::into),
                std::path::Path::new(&cwd),
            );
            show_main_window(app);
        }));
    }
    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .manage(PendingDeepLink::default())
        .manage(PendingFiles::default())
        .manage(MiniViewer::default());
    let app = builder
        .invoke_handler(tauri::generate_handler![
            desktop_bootstrap,
            desktop_ui_connected,
            desktop_open_vault,
            desktop_vault_status,
            desktop_list_vaults,
            desktop_create_vault,
            desktop_repair_vault,
            desktop_update_vault,
            desktop_vault_policy,
            desktop_choose_vault_folder,
            desktop_pick_folder,
            desktop_pick_file,
            desktop_open_external_url,
            desktop_reveal_path,
            desktop_open_path,
            desktop_take_pending_deep_link,
            desktop_take_pending_files,
            desktop_has_pending_files,
            desktop_tailscale_status,
            desktop_set_tailscale_enabled,
            desktop_check_for_update,
            desktop_install_pending_update,
            desktop_arm_microphone,
            desktop_show_main_window,
            mini_viewer::desktop_open_mini_viewer,
            mini_viewer::desktop_set_mini_viewer_on_top,
            mini_viewer::desktop_mini_viewer_on_top,
            quit_modus
        ])
        .setup(|app| {
            let supervisor =
                Arc::new(BackendSupervisor::new(app.handle()).map_err(std::io::Error::other)?);
            supervisor.start_monitor(app.handle().clone());
            app.manage(supervisor);

            if let Ok(cwd) = env::current_dir() {
                file_open::dispatch_arguments(app.handle(), env::args_os().skip(1), &cwd);
            }

            // Answers the Linux webview's native capture prompt, which is
            // denied by default and left the composer mic reporting "mic
            // blocked" on a machine whose microphone worked everywhere else.
            // A no-op on Windows and macOS.
            let microphone = Arc::new(MicrophoneArm::default());
            media_permission::install(app.handle(), Arc::clone(&microphone));
            app.manage(microphone);

            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Linux has no installer to own the registration, and on Windows
                // the NSIS installer registers the scheme only for installed
                // release builds — so development builds claim it at runtime.
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                if !allow_parallel_smoke_instance() {
                    if let Err(error) = app.deep_link().register_all() {
                        eprintln!("[desktop] could not register the modus:// scheme: {error}");
                    }
                }

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls().into_iter().map(|url| url.to_string());
                    // Only a link we actually understood raises the window here.
                    // On Windows and Linux a link to a running app arrives as a
                    // second process, so the single-instance callback above has
                    // already surfaced the window whatever the link said.
                    if deep_link::dispatch(&handle, urls) {
                        show_main_window(&handle);
                    }
                });

                // The OS may have launched us *because* of a link, in which case
                // it is already waiting and no open-url event will follow.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    deep_link::dispatch(app.handle(), urls.into_iter().map(|url| url.to_string()));
                }
            }

            let show = MenuItem::with_id(app, "show", "Show Modus", true, None::<&str>)?;
            let mini = MenuItem::with_id(app, "mini", "Open Mini Viewer", true, None::<&str>)?;
            let mini_on_top = CheckMenuItem::with_id(
                app,
                "mini-on-top",
                "Keep Mini Viewer on Top",
                true,
                app.state::<MiniViewer>().on_top(),
                None::<&str>,
            )?;
            app.state::<MiniViewer>()
                .attach_tray_pin(mini_on_top.clone());
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Modus", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &mini, &mini_on_top, &separator, &quit])?;
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
                    "mini" => {
                        if let Err(error) = mini_viewer::open(app, None, None) {
                            eprintln!("[desktop] {error}");
                        }
                    }
                    "mini-on-top" => {
                        // The check item has already toggled itself; read the
                        // pin from state so a stale item cannot drift from it.
                        let on_top = !app.state::<MiniViewer>().on_top();
                        mini_viewer::set_on_top(app, on_top);
                    }
                    "quit" => begin_quit(app.clone()),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Only the main window hides to the tray. Closing the mini
                // viewer really closes it, and reopening starts it fresh.
                if window.label() == "main" && !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Modus desktop");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let paths = urls.into_iter().filter_map(|url| {
                let path = url.to_file_path().ok()?;
                file_open::validate(&path, std::path::Path::new("/"))
            });
            if file_open::dispatch(app, paths) {
                show_main_window(app);
            }
        }
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
