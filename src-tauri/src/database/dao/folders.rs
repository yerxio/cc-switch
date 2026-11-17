//! 文件夹数据访问对象（Skills 与 MCP 共用一套实现，各有各的表）
//!
//! 文件夹是纯收纳视图：各工具只认扁平的 skills 目录 / 配置文件里的一张表，所以
//! 这里不对应任何磁盘结构，只记「哪个条目归在哪个文件夹」。
//!
//! 每一类两张表，结构相同：
//! - `<kind>_folders`：文件夹本身（名字大小写不敏感唯一）
//! - `<kind>_folder_items`：归属，条目 id 作主键——一个条目最多一个文件夹
//!
//! Skills 和 MCP 的文件夹互不相干：各建各的、可以重名。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::params;

/// 哪一类条目的文件夹
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    Skill,
    Mcp,
}

impl FolderKind {
    /// 文件夹表
    fn folders_table(self) -> &'static str {
        match self {
            FolderKind::Skill => "skill_folders",
            FolderKind::Mcp => "mcp_folders",
        }
    }

    /// 归属表
    fn items_table(self) -> &'static str {
        match self {
            FolderKind::Skill => "skill_folder_items",
            FolderKind::Mcp => "mcp_folder_items",
        }
    }

    /// 归属表里条目 id 那一列
    fn item_column(self) -> &'static str {
        match self {
            FolderKind::Skill => "skill_id",
            FolderKind::Mcp => "server_id",
        }
    }

    /// 条目本身所在的表（清理孤儿归属时用）
    fn source_table(self) -> &'static str {
        match self {
            FolderKind::Skill => "skills",
            FolderKind::Mcp => "mcp_servers",
        }
    }
}

/// 一个文件夹
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderRow {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

// 下面的 SQL 都用 format! 拼表名 / 列名：它们只来自上面那几个 &'static str，
// 不含任何外部输入；值一律走参数绑定。
impl Database {
    /// 列出所有文件夹（先按 sort_order，再按名字）
    pub fn list_folders(&self, kind: FolderKind) -> Result<Vec<FolderRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, name, sort_order, created_at FROM {}
                 ORDER BY sort_order, name COLLATE NOCASE, id",
                kind.folders_table()
            ))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(FolderRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    /// 新建文件夹。重名（大小写不敏感）由 UNIQUE 约束挡住，调用方应先查重给出友好报错。
    pub fn insert_folder(&self, kind: FolderKind, folder: &FolderRow) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            &format!(
                "INSERT INTO {} (id, name, sort_order, created_at) VALUES (?1, ?2, ?3, ?4)",
                kind.folders_table()
            ),
            params![folder.id, folder.name, folder.sort_order, folder.created_at],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 重命名文件夹
    pub fn rename_folder(&self, kind: FolderKind, id: &str, name: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                &format!(
                    "UPDATE {} SET name = ?2 WHERE id = ?1",
                    kind.folders_table()
                ),
                params![id, name],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 删除文件夹。里面的条目不动，只是回到「未分类」。
    pub fn delete_folder(&self, kind: FolderKind, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            &format!("DELETE FROM {} WHERE folder_id = ?1", kind.items_table()),
            params![id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        let changed = conn
            .execute(
                &format!("DELETE FROM {} WHERE id = ?1", kind.folders_table()),
                params![id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 全部归属：`(条目 id, 文件夹 id)`
    pub fn list_folder_items(&self, kind: FolderKind) -> Result<Vec<(String, String)>, AppError> {
        let conn = lock_conn!(self.conn);
        let column = kind.item_column();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {column}, folder_id FROM {} ORDER BY {column}",
                kind.items_table()
            ))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    /// 把一批条目放进某个文件夹；`folder_id` 为 `None` 则移回「未分类」。
    ///
    /// 整批放在一个事务里：一千多条逐条提交会是一千多次 fsync。
    pub fn assign_items_to_folder(
        &self,
        kind: FolderKind,
        item_ids: &[String],
        folder_id: Option<&str>,
    ) -> Result<usize, AppError> {
        let mut conn = lock_conn!(self.conn);
        let table = kind.items_table();
        let column = kind.item_column();
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut changed = 0usize;
        for item_id in item_ids {
            changed += match folder_id {
                Some(folder_id) => tx.execute(
                    &format!(
                        "INSERT INTO {table} ({column}, folder_id) VALUES (?1, ?2)
                         ON CONFLICT({column}) DO UPDATE SET folder_id = excluded.folder_id"
                    ),
                    params![item_id, folder_id],
                ),
                None => tx.execute(
                    &format!("DELETE FROM {table} WHERE {column} = ?1"),
                    params![item_id],
                ),
            }
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed)
    }

    /// 清掉指向已删除条目或已删除文件夹的归属行。
    ///
    /// 删除条目有好几条路径（单条、批量、同步导入覆盖），与其每条路径都记得来清，
    /// 不如读状态前统一收一次。
    pub fn prune_folder_items(&self, kind: FolderKind) -> Result<usize, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                &format!(
                    "DELETE FROM {items}
                     WHERE {column} NOT IN (SELECT id FROM {source})
                        OR folder_id NOT IN (SELECT id FROM {folders})",
                    items = kind.items_table(),
                    column = kind.item_column(),
                    source = kind.source_table(),
                    folders = kind.folders_table(),
                ),
                [],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed)
    }
}
