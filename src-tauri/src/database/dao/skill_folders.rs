//! Skill 文件夹数据访问对象
//!
//! 文件夹是纯收纳视图：各工具只认扁平的 `<skills>/<name>/SKILL.md`，所以这里
//! 不对应任何磁盘目录，只记「哪个 Skill 归在哪个文件夹」。
//!
//! - `skill_folders`：文件夹本身（名字大小写不敏感唯一）
//! - `skill_folder_items`：归属，`skill_id` 作主键——一个 Skill 最多一个文件夹

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::params;

/// 一个文件夹
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFolderRow {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

impl Database {
    /// 列出所有文件夹（先按 sort_order，再按名字）
    pub fn list_skill_folders(&self) -> Result<Vec<SkillFolderRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, sort_order, created_at FROM skill_folders
                 ORDER BY sort_order, name COLLATE NOCASE, id",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SkillFolderRow {
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
    pub fn insert_skill_folder(&self, folder: &SkillFolderRow) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO skill_folders (id, name, sort_order, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![folder.id, folder.name, folder.sort_order, folder.created_at],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 重命名文件夹
    pub fn rename_skill_folder(&self, id: &str, name: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "UPDATE skill_folders SET name = ?2 WHERE id = ?1",
                params![id, name],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 删除文件夹。里面的 Skill 不动，只是回到「未分类」。
    pub fn delete_skill_folder(&self, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM skill_folder_items WHERE folder_id = ?1",
            params![id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        let changed = conn
            .execute("DELETE FROM skill_folders WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 全部归属：`(skill_id, folder_id)`
    pub fn list_skill_folder_items(&self) -> Result<Vec<(String, String)>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT skill_id, folder_id FROM skill_folder_items ORDER BY skill_id")
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

    /// 把一批 Skill 放进某个文件夹；`folder_id` 为 `None` 则移回「未分类」。
    ///
    /// 整批放在一个事务里：一千多条逐条提交会是一千多次 fsync。
    pub fn assign_skills_to_folder(
        &self,
        skill_ids: &[String],
        folder_id: Option<&str>,
    ) -> Result<usize, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut changed = 0usize;
        for skill_id in skill_ids {
            changed += match folder_id {
                Some(folder_id) => tx.execute(
                    "INSERT INTO skill_folder_items (skill_id, folder_id) VALUES (?1, ?2)
                     ON CONFLICT(skill_id) DO UPDATE SET folder_id = excluded.folder_id",
                    params![skill_id, folder_id],
                ),
                None => tx.execute(
                    "DELETE FROM skill_folder_items WHERE skill_id = ?1",
                    params![skill_id],
                ),
            }
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed)
    }

    /// 清掉指向已卸载 Skill 或已删除文件夹的归属行。
    ///
    /// 卸载有好几条路径（单条、批量、同步导入覆盖），与其每条路径都记得来清，
    /// 不如读状态前统一收一次。
    pub fn prune_skill_folder_items(&self) -> Result<usize, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "DELETE FROM skill_folder_items
                 WHERE skill_id NOT IN (SELECT id FROM skills)
                    OR folder_id NOT IN (SELECT id FROM skill_folders)",
                [],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed)
    }
}
