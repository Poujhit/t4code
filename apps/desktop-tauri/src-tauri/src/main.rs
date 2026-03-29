mod commands;
mod sidecar;

use tauri::Manager;

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::desktop_state,
            commands::unsupported_bridge_method
        ])
        .setup(|app| {
            let runtime_state = sidecar::DesktopRuntimeState::initialize(app.handle())?;
            app.manage(runtime_state);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build t4code");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
            if let Some(state) = app_handle.try_state::<sidecar::DesktopRuntimeState>() {
                state.shutdown();
            }
        }
        _ => {}
    });
}

