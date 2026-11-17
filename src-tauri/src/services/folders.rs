//! 文件夹：Skills 与 MCP 共用的收纳视图
//!
//! 文件夹是虚拟的——只存在于数据库，影响面板怎么分组、怎么批量操作，**不改变
//! 任何文件或配置的落点**。各工具照旧只看到扁平的 skills 目录和配置文件里的
//! 一张 MCP 表。
//!
//! 两个取舍：只有一层（不嵌套），一个条目最多在一个文件夹里。
//! Skills 和 MCP 各有各的文件夹，互不相干。

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;

use crate::database::{Database, FolderKind, FolderRow};
use crate::error::AppError;

/// 文件夹名长度上限（字符数）
const MAX_FOLDER_NAME_CHARS: usize = 64;

/// 一个文件夹（给前端的形态）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

impl From<FolderRow> for Folder {
    fn from(row: FolderRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            sort_order: row.sort_order,
        }
    }
}

/// 面板一次拉取的文件夹状态
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldersState {
    pub folders: Vec<Folder>,
    /// 条目 id → 文件夹 id。不在这里面的条目就是「未分类」。
    pub assignments: BTreeMap<String, String>,
}

pub struct FolderService;

impl FolderService {
    /// 文件夹与归属的完整状态。读之前顺手清掉指向已删除条目的归属行。
    pub fn state(db: &Arc<Database>, kind: FolderKind) -> Result<FoldersState, AppError> {
        db.prune_folder_items(kind)?;
        let folders = db
            .list_folders(kind)?
            .into_iter()
            .map(Folder::from)
            .collect();
        let assignments = db.list_folder_items(kind)?.into_iter().collect();
        Ok(FoldersState {
            folders,
            assignments,
        })
    }

    /// 规范化并校验文件夹名
    fn clean_name(raw: &str) -> Result<String, AppError> {
        let name = raw.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("文件夹名不能为空".into()));
        }
        if name.chars().count() > MAX_FOLDER_NAME_CHARS {
            return Err(AppError::InvalidInput(format!(
                "文件夹名不能超过 {MAX_FOLDER_NAME_CHARS} 个字符"
            )));
        }
        if name.chars().any(char::is_control) {
            return Err(AppError::InvalidInput("文件夹名里有不可见字符".into()));
        }
        Ok(name.to_string())
    }

    fn find_by_name(
        db: &Arc<Database>,
        kind: FolderKind,
        name: &str,
    ) -> Result<Option<FolderRow>, AppError> {
        let wanted = name.to_lowercase();
        Ok(db
            .list_folders(kind)?
            .into_iter()
            .find(|row| row.name.to_lowercase() == wanted))
    }

    fn insert(db: &Arc<Database>, kind: FolderKind, name: String) -> Result<FolderRow, AppError> {
        // 新文件夹排在最后
        let next_order = db
            .list_folders(kind)?
            .iter()
            .map(|row| row.sort_order)
            .max()
            .map_or(0, |max| max + 1);
        let row = FolderRow {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            sort_order: next_order,
            created_at: chrono::Utc::now().timestamp(),
        };
        db.insert_folder(kind, &row)?;
        Ok(row)
    }

    /// 新建文件夹；重名（不分大小写）报错
    pub fn create(
        db: &Arc<Database>,
        kind: FolderKind,
        raw_name: &str,
    ) -> Result<Folder, AppError> {
        let name = Self::clean_name(raw_name)?;
        if Self::find_by_name(db, kind, &name)?.is_some() {
            return Err(AppError::InvalidInput(format!(
                "已经有名为 {name} 的文件夹"
            )));
        }
        let row = Self::insert(db, kind, name)?;
        log::info!("文件夹（{kind:?}）：新建 {}", row.name);
        Ok(row.into())
    }

    /// 按名字取文件夹 id，没有就建。导入时用：同名文件夹直接并进去。
    pub fn ensure(
        db: &Arc<Database>,
        kind: FolderKind,
        raw_name: &str,
    ) -> Result<String, AppError> {
        let name = Self::clean_name(raw_name)?;
        if let Some(existing) = Self::find_by_name(db, kind, &name)? {
            return Ok(existing.id);
        }
        Ok(Self::insert(db, kind, name)?.id)
    }

    pub fn rename(
        db: &Arc<Database>,
        kind: FolderKind,
        id: &str,
        raw_name: &str,
    ) -> Result<(), AppError> {
        let name = Self::clean_name(raw_name)?;
        if let Some(other) = Self::find_by_name(db, kind, &name)? {
            if other.id != id {
                return Err(AppError::InvalidInput(format!(
                    "已经有名为 {name} 的文件夹"
                )));
            }
        }
        if !db.rename_folder(kind, id, &name)? {
            return Err(AppError::InvalidInput(format!("文件夹不存在: {id}")));
        }
        Ok(())
    }

    /// 删除文件夹。里面的条目不删，只是回到「未分类」。
    pub fn delete(db: &Arc<Database>, kind: FolderKind, id: &str) -> Result<(), AppError> {
        if !db.delete_folder(kind, id)? {
            return Err(AppError::InvalidInput(format!("文件夹不存在: {id}")));
        }
        log::info!("文件夹（{kind:?}）：删除 {id}");
        Ok(())
    }

    /// 把一批条目移进某个文件夹；`folder_id` 为 `None` 则移回「未分类」。
    pub fn move_items(
        db: &Arc<Database>,
        kind: FolderKind,
        item_ids: &[String],
        folder_id: Option<&str>,
    ) -> Result<usize, AppError> {
        if let Some(folder_id) = folder_id {
            if !db.list_folders(kind)?.iter().any(|row| row.id == folder_id) {
                return Err(AppError::InvalidInput(format!("文件夹不存在: {folder_id}")));
            }
        }
        db.assign_items_to_folder(kind, item_ids, folder_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::{McpApps, McpServer};
    use serde_json::json;

    fn seed_server(db: &Arc<Database>, id: &str) {
        db.save_mcp_server(&McpServer {
            id: id.to_string(),
            name: id.to_string(),
            server: json!({ "command": "npx" }),
            apps: McpApps::default(),
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save server");
    }

    /// MCP 的文件夹和 Skills 的互不相干：各建各的，可以重名
    #[test]
    fn mcp_and_skill_folders_are_separate_namespaces() {
        let db = Arc::new(Database::memory().expect("memory db"));

        let mcp = FolderService::create(&db, FolderKind::Mcp, "Web").expect("mcp folder");
        let skill = FolderService::create(&db, FolderKind::Skill, "Web").expect("skill folder");
        assert_ne!(mcp.id, skill.id, "同名但各是各的");

        // 在同一类里才算重名
        assert!(FolderService::create(&db, FolderKind::Mcp, "web").is_err());

        FolderService::delete(&db, FolderKind::Mcp, &mcp.id).expect("delete mcp folder");
        assert_eq!(
            FolderService::state(&db, FolderKind::Skill)
                .expect("skill state")
                .folders
                .len(),
            1,
            "删 MCP 的文件夹不该碰到 Skills 的"
        );
    }

    #[test]
    fn mcp_servers_move_between_folders_and_drop_out_when_deleted() {
        let db = Arc::new(Database::memory().expect("memory db"));
        seed_server(&db, "fetch");
        seed_server(&db, "time");

        let tools = FolderService::create(&db, FolderKind::Mcp, "Tools").expect("create");
        let web = FolderService::create(&db, FolderKind::Mcp, "Web").expect("create");
        let ids = vec!["fetch".to_string(), "time".to_string()];
        FolderService::move_items(&db, FolderKind::Mcp, &ids, Some(&tools.id)).expect("move in");
        // 换文件夹是换，不是又多一份
        FolderService::move_items(&db, FolderKind::Mcp, &ids[..1], Some(&web.id))
            .expect("move over");

        let state = FolderService::state(&db, FolderKind::Mcp).expect("state");
        assert_eq!(state.assignments.get("fetch"), Some(&web.id));
        assert_eq!(state.assignments.get("time"), Some(&tools.id));

        // 服务器被删掉后，它的归属行在下次读状态时清掉
        db.delete_mcp_server("fetch").expect("delete server");
        let state = FolderService::state(&db, FolderKind::Mcp).expect("state");
        assert!(!state.assignments.contains_key("fetch"));
        assert_eq!(state.assignments.len(), 1);

        // 移到不存在的文件夹要报错，而不是悄悄写一行悬空的归属
        assert!(FolderService::move_items(&db, FolderKind::Mcp, &ids[1..], Some("nope")).is_err());
    }

    #[test]
    fn deleting_an_mcp_folder_keeps_its_servers() {
        let db = Arc::new(Database::memory().expect("memory db"));
        seed_server(&db, "fetch");
        let folder = FolderService::create(&db, FolderKind::Mcp, "Tools").expect("create");
        FolderService::move_items(
            &db,
            FolderKind::Mcp,
            &["fetch".to_string()],
            Some(&folder.id),
        )
        .expect("move");

        FolderService::delete(&db, FolderKind::Mcp, &folder.id).expect("delete");

        assert!(FolderService::state(&db, FolderKind::Mcp)
            .expect("state")
            .assignments
            .is_empty());
        assert!(
            db.get_all_mcp_servers()
                .expect("servers")
                .contains_key("fetch"),
            "删文件夹不删里面的服务器"
        );
    }
}
