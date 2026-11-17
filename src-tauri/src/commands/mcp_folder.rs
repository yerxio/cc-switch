//! MCP 文件夹命令层
//!
//! 和 Skill 文件夹是同一套通用实现（[`crate::services::folders`]），只是种类不同；
//! 两边的文件夹互不相干。文件夹是纯收纳视图，不改变任何配置文件的内容。

use super::run_db_task;
use crate::database::FolderKind;
use crate::services::folders::{Folder, FolderService, FoldersState};
use crate::store::AppState;
use tauri::State;

/// 文件夹列表 + 每个 MCP 服务器的归属
#[tauri::command]
pub async fn get_mcp_folders(app_state: State<'_, AppState>) -> Result<FoldersState, String> {
    run_db_task(&app_state, |state| {
        FolderService::state(&state.db, FolderKind::Mcp).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn create_mcp_folder(
    name: String,
    app_state: State<'_, AppState>,
) -> Result<Folder, String> {
    run_db_task(&app_state, move |state| {
        FolderService::create(&state.db, FolderKind::Mcp, &name).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn rename_mcp_folder(
    id: String,
    name: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    run_db_task(&app_state, move |state| {
        FolderService::rename(&state.db, FolderKind::Mcp, &id, &name).map_err(|e| e.to_string())
    })
    .await
}

/// 删除文件夹。里面的服务器不删，只是回到「未分类」。
#[tauri::command]
pub async fn delete_mcp_folder(id: String, app_state: State<'_, AppState>) -> Result<(), String> {
    run_db_task(&app_state, move |state| {
        FolderService::delete(&state.db, FolderKind::Mcp, &id).map_err(|e| e.to_string())
    })
    .await
}

/// 把一批服务器移进某个文件夹；`folder_id` 省略则移回「未分类」。
#[tauri::command]
pub async fn move_mcp_servers_to_folder(
    server_ids: Vec<String>,
    folder_id: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<usize, String> {
    run_db_task(&app_state, move |state| {
        FolderService::move_items(
            &state.db,
            FolderKind::Mcp,
            &server_ids,
            folder_id.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
    .await
}
