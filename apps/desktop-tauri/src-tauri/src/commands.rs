use serde::Serialize;
use tauri::State;

use crate::sidecar::DesktopRuntimeState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatePayload {
    ws_url: String,
}

#[tauri::command]
pub fn desktop_state(state: State<'_, DesktopRuntimeState>) -> Result<DesktopStatePayload, String> {
    Ok(DesktopStatePayload {
        ws_url: state.ws_url(),
    })
}

#[tauri::command]
pub fn unsupported_bridge_method() -> Result<(), String> {
    Err("This desktop bridge method is not implemented in t4code yet.".to_string())
}

