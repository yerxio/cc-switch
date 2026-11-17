//! 项目级作用域命令层
//!
//! 把受管的 MCP / Skills 投影到单个仓库内部。所有写入都在项目目录里，
//! 不碰任何全局配置（详见 [`crate::services::project_scope`] 的模块文档）。

use super::run_db_task;
use crate::services::project_scope::{
    ProjectApp, ProjectScopeService, ProjectScopeState, ResyncFailure, ResyncReport, ScopedProject,
    ToggleOutcome,
};
use crate::store::AppState;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// 选一个项目目录（受管项目的唯一入口之一，另一个是会话历史里的候选）
#[tauri::command]
pub async fn open_project_directory_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let result = app.dialog().file().blocking_pick_folder();
    Ok(result.map(|path| path.to_string()))
}

/// 列出受管项目
#[tauri::command]
pub async fn list_scoped_projects(
    app_state: State<'_, AppState>,
) -> Result<Vec<ScopedProject>, String> {
    run_db_task(&app_state, |state| {
        ProjectScopeService::list_projects(&state.db).map_err(|e| e.to_string())
    })
    .await
}

/// 加入一个受管项目（同路径重复加是幂等的）
#[tauri::command]
pub async fn add_scoped_project(
    path: String,
    app_state: State<'_, AppState>,
) -> Result<ScopedProject, String> {
    run_db_task(&app_state, move |state| {
        ProjectScopeService::add_project(&state.db, &path).map_err(|e| e.to_string())
    })
    .await
}

/// 重命名受管项目
#[tauri::command]
pub async fn rename_scoped_project(
    id: String,
    name: String,
    app_state: State<'_, AppState>,
) -> Result<bool, String> {
    run_db_task(&app_state, move |state| {
        ProjectScopeService::rename_project(&state.db, &id, &name).map_err(|e| e.to_string())
    })
    .await
}

/// 移出受管项目。
///
/// `cleanup` 为真时先把 CC Switch 在该仓库里写过的东西全部撤掉；为假则只删绑定
/// 记录，仓库里已生成的文件原样保留。返回撤销过程中逐条失败的项。
#[tauri::command]
pub async fn remove_scoped_project(
    id: String,
    cleanup: bool,
    app_state: State<'_, AppState>,
) -> Result<Vec<ResyncFailure>, String> {
    run_db_task(&app_state, move |state| {
        ProjectScopeService::remove_project(&state.db, &id, cleanup).map_err(|e| e.to_string())
    })
    .await
}

/// 读一个项目的完整状态（每个条目在两个应用下的三态 + Codex 信任 + 外来条目）
#[tauri::command]
pub async fn get_project_scope_state(
    project_id: String,
    app_state: State<'_, AppState>,
) -> Result<ProjectScopeState, String> {
    run_db_task(&app_state, move |state| {
        ProjectScopeService::read_state(&state.db, &project_id).map_err(|e| e.to_string())
    })
    .await
}

/// 勾选/取消一个 MCP server 在某项目某应用下的绑定。
///
/// 目标文件里已有同名键时返回 `{ status: "conflict", key, path }` 而不是报错，
/// 界面问过用户后带 `force = true` 再调一次就覆盖。
#[tauri::command]
pub async fn toggle_project_mcp(
    project_id: String,
    server_id: String,
    app: String,
    enabled: bool,
    force: bool,
    app_state: State<'_, AppState>,
) -> Result<ToggleOutcome, String> {
    let target = ProjectApp::parse(&app).map_err(|e| e.to_string())?;
    run_db_task(&app_state, move |state| {
        ProjectScopeService::toggle_mcp(&state.db, &project_id, &server_id, target, enabled, force)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 勾选/取消一个 Skill 在某项目某应用下的绑定。
///
/// skills 目录下已有同名目录时返回 `{ status: "conflict", key, path }`；
/// 强制覆盖会**整个替换**那个目录。
#[tauri::command]
pub async fn toggle_project_skill(
    project_id: String,
    skill_id: String,
    app: String,
    enabled: bool,
    force: bool,
    app_state: State<'_, AppState>,
) -> Result<ToggleOutcome, String> {
    let target = ProjectApp::parse(&app).map_err(|e| e.to_string())?;
    run_db_task(&app_state, move |state| {
        ProjectScopeService::toggle_skill(&state.db, &project_id, &skill_id, target, enabled, force)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 按库里的绑定全量重投一次（修复手改或误删造成的漂移）
#[tauri::command]
pub async fn resync_project_scope(
    project_id: String,
    app_state: State<'_, AppState>,
) -> Result<ResyncReport, String> {
    run_db_task(&app_state, move |state| {
        ProjectScopeService::resync(&state.db, &project_id).map_err(|e| e.to_string())
    })
    .await
}
