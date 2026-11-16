//! 项目级作用域数据访问对象
//!
//! 两张表：
//! - `scoped_projects`：受管的项目目录（规范化绝对路径 + 显示名）
//! - `project_bindings`：「项目 × 条目 × 应用」的绑定，条目是 MCP server 或 Skill
//!
//! 与 `profiles` 的区别：profiles 存的是全局状态快照、语义是互斥切换；这里是按
//! 目录并存生效的绑定，投影目标全部位于用户仓库内部。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::params;

/// 受管项目记录
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedProjectRow {
    pub id: String,
    /// 规范化后的绝对路径
    pub path: String,
    pub name: String,
    pub added_at: i64,
}

/// 一条绑定记录（项目 × 条目 × 应用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectBindingRow {
    pub project_id: String,
    /// `mcp` | `skill`
    pub kind: String,
    pub item_id: String,
    /// `claude` | `codex`
    pub app: String,
    pub bound_at: i64,
}

impl Database {
    /// 列出所有受管项目（按加入时间倒序，同刻按名字稳定排序）
    pub fn list_scoped_projects(&self) -> Result<Vec<ScopedProjectRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, path, name, added_at FROM scoped_projects
                 ORDER BY added_at DESC, name, id",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ScopedProjectRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    added_at: row.get(3)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    /// 按 id 读一个受管项目
    pub fn get_scoped_project(&self, id: &str) -> Result<Option<ScopedProjectRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT id, path, name, added_at FROM scoped_projects WHERE id = ?1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(ScopedProjectRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    added_at: row.get(3)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| AppError::Database(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// 按路径读一个受管项目（路径是 UNIQUE，用于「加过没有」判断）
    pub fn get_scoped_project_by_path(
        &self,
        path: &str,
    ) -> Result<Option<ScopedProjectRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT id, path, name, added_at FROM scoped_projects WHERE path = ?1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![path], |row| {
                Ok(ScopedProjectRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    added_at: row.get(3)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| AppError::Database(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// 新增或更新一个受管项目（按 id 幂等；重复 add 只刷新显示名）
    pub fn upsert_scoped_project(&self, project: &ScopedProjectRow) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO scoped_projects (id, path, name, added_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path",
            params![project.id, project.path, project.name, project.added_at],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 重命名受管项目
    pub fn rename_scoped_project(&self, id: &str, name: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "UPDATE scoped_projects SET name = ?2 WHERE id = ?1",
                params![id, name],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 删除受管项目及其所有绑定
    ///
    /// 不依赖 `PRAGMA foreign_keys`（本库未必开启），显式先删子表。
    pub fn delete_scoped_project(&self, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM project_bindings WHERE project_id = ?1",
            params![id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        let changed = conn
            .execute("DELETE FROM scoped_projects WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 列出一个项目的全部绑定
    pub fn list_project_bindings(
        &self,
        project_id: &str,
    ) -> Result<Vec<ProjectBindingRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT project_id, kind, item_id, app, bound_at FROM project_bindings
                 WHERE project_id = ?1
                 ORDER BY kind, item_id, app",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(ProjectBindingRow {
                    project_id: row.get(0)?,
                    kind: row.get(1)?,
                    item_id: row.get(2)?,
                    app: row.get(3)?,
                    bound_at: row.get(4)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    /// 列出所有项目的全部绑定（面板上要标「这个条目还绑在别的项目里」）
    pub fn list_all_project_bindings(&self) -> Result<Vec<ProjectBindingRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT project_id, kind, item_id, app, bound_at FROM project_bindings
                 ORDER BY project_id, kind, item_id, app",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectBindingRow {
                    project_id: row.get(0)?,
                    kind: row.get(1)?,
                    item_id: row.get(2)?,
                    app: row.get(3)?,
                    bound_at: row.get(4)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    /// 写入一条绑定（幂等）
    pub fn add_project_binding(
        &self,
        project_id: &str,
        kind: &str,
        item_id: &str,
        app: &str,
        bound_at: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO project_bindings (project_id, kind, item_id, app, bound_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_id, kind, item_id, app) DO NOTHING",
            params![project_id, kind, item_id, app, bound_at],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 删除一条绑定；返回是否真的删掉了
    pub fn remove_project_binding(
        &self,
        project_id: &str,
        kind: &str,
        item_id: &str,
        app: &str,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "DELETE FROM project_bindings
                 WHERE project_id = ?1 AND kind = ?2 AND item_id = ?3 AND app = ?4",
                params![project_id, kind, item_id, app],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// 条目被卸载/删除时清掉它在所有项目里的绑定（文件侧的撤销由 service 负责）
    pub fn remove_project_bindings_for_item(
        &self,
        kind: &str,
        item_id: &str,
    ) -> Result<usize, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "DELETE FROM project_bindings WHERE kind = ?1 AND item_id = ?2",
                params![kind, item_id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed)
    }
}
