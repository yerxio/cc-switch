//! Skill 文件夹命令层
//!
//! 文件夹是纯收纳视图，不对应磁盘目录（见 [`crate::services::skill_folder`]）。

use super::run_db_task;
use crate::services::skill_folder::{
    SkillExportReport, SkillFolder, SkillFolderService, SkillFoldersState,
};
use crate::store::AppState;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// 文件夹列表 + 每个 Skill 的归属
#[tauri::command]
pub async fn get_skill_folders(
    app_state: State<'_, AppState>,
) -> Result<SkillFoldersState, String> {
    run_db_task(&app_state, |state| {
        SkillFolderService::state(&state.db).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn create_skill_folder(
    name: String,
    app_state: State<'_, AppState>,
) -> Result<SkillFolder, String> {
    run_db_task(&app_state, move |state| {
        SkillFolderService::create(&state.db, &name).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn rename_skill_folder(
    id: String,
    name: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    run_db_task(&app_state, move |state| {
        SkillFolderService::rename(&state.db, &id, &name).map_err(|e| e.to_string())
    })
    .await
}

/// 删除文件夹。里面的 Skill 不卸载，只是回到「未分类」。
#[tauri::command]
pub async fn delete_skill_folder(id: String, app_state: State<'_, AppState>) -> Result<(), String> {
    run_db_task(&app_state, move |state| {
        SkillFolderService::delete(&state.db, &id).map_err(|e| e.to_string())
    })
    .await
}

/// 把一批 Skill 移进某个文件夹；`folder_id` 省略则移回「未分类」。
#[tauri::command]
pub async fn move_skills_to_folder(
    skill_ids: Vec<String>,
    folder_id: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<usize, String> {
    run_db_task(&app_state, move |state| {
        SkillFolderService::move_skills(&state.db, &skill_ids, folder_id.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
}

/// 选一个保存 ZIP 的位置
#[tauri::command]
pub async fn save_skills_zip_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    default_name: String,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(result.map(|path| path.to_string()))
}

/// 把选中的 Skill 导出成 ZIP，保留文件夹层级
#[tauri::command]
pub async fn export_skills_zip(
    skill_ids: Vec<String>,
    file_path: String,
    app_state: State<'_, AppState>,
) -> Result<SkillExportReport, String> {
    run_db_task(&app_state, move |state| {
        SkillFolderService::export_zip(&state.db, &skill_ids, std::path::Path::new(&file_path))
            .map_err(|e| e.to_string())
    })
    .await
}
