//! 项目级作用域：把受 CC Switch 管理的 MCP / Skills 投影到**单个仓库内部**
//!
//! 与全局投影（`services/skill.rs`、`mcp/*.rs`）的根本区别：这里写的每一个字节都
//! 落在用户指定的项目目录里，**绝不触碰任何全局配置**——不改 `~/.claude.json`、
//! 不改 `~/.claude/settings.json`、不改 `~/.codex/config.toml`。Codex 的项目信任
//! 状态只读取、不代写。
//!
//! ## 投影目标（第一版只支持 Claude Code 与 Codex CLI）
//!
//! | 应用 | MCP | Skills |
//! | --- | --- | --- |
//! | Claude Code | `<repo>/.mcp.json` 的 `mcpServers.<id>`，并在 `<repo>/.claude/settings.local.json` 的 `enabledMcpjsonServers` 里预批准 | `<repo>/.claude/skills/<dir>/` |
//! | Codex CLI | `<repo>/.codex/config.toml` 的 `[mcp_servers.<id>]` | `<repo>/.agents/skills/<dir>/` |
//!
//! Codex 的 skills 目录是 `.agents/skills`（现行约定），不是历史上的 `.codex/skills`。
//!
//! ## 两条硬规则
//!
//! 1. **不覆盖别人的东西**：目标文件里已有同名条目、但 CC Switch 没有对应绑定记录
//!    （队友提交的、用户手写的），一律拒绝写入并如实报错，而不是悄悄顶掉。
//! 2. **撤销要干净**：取消绑定后若 `mcpServers` / `[mcp_servers]` 空了就把文件删掉，
//!    不在用户仓库里留 `{"mcpServers":{}}` 这种残骸。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::app_config::AppType;
use crate::database::{Database, ProjectBindingRow, ScopedProjectRow};
use crate::error::AppError;
use crate::services::skill::SkillService;

/// 绑定种类在库里的取值
const KIND_MCP: &str = "mcp";
const KIND_SKILL: &str = "skill";

/// 项目级支持的应用。第一版只有两个，刻意不复用 [`AppType`]：那是 15 个应用的
/// 全集，用它当参数类型会让「这里只支持两个」变成运行时才发现的事。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectApp {
    Claude,
    Codex,
}

impl ProjectApp {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectApp::Claude => "claude",
            ProjectApp::Codex => "codex",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw {
            "claude" => Ok(ProjectApp::Claude),
            "codex" => Ok(ProjectApp::Codex),
            other => Err(AppError::InvalidInput(format!(
                "项目级作用域暂不支持应用 {other}（当前支持 claude、codex）"
            ))),
        }
    }

    /// 对应的全局 [`AppType`]，用来读「全局是否已启用」的继承态
    pub fn app_type(self) -> AppType {
        match self {
            ProjectApp::Claude => AppType::Claude,
            ProjectApp::Codex => AppType::Codex,
        }
    }

    pub fn all() -> [ProjectApp; 2] {
        [ProjectApp::Claude, ProjectApp::Codex]
    }
}

/// 受管项目（给前端的形态）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedProject {
    pub id: String,
    pub path: String,
    pub name: String,
    pub added_at: i64,
    /// 目录当前是否还在（被移走/删掉的项目在界面上标灰）
    pub exists: bool,
}

impl ScopedProject {
    fn from_row(row: ScopedProjectRow) -> Self {
        let exists = Path::new(&row.path).is_dir();
        Self {
            id: row.id,
            path: row.path,
            name: row.name,
            added_at: row.added_at,
            exists,
        }
    }
}

/// 从会话历史里发现的候选项目（用户不用手填路径）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCandidate {
    pub path: String,
    pub name: String,
    /// 哪些应用在这个目录里有过会话
    pub apps: Vec<String>,
    pub last_active_at: Option<i64>,
    /// 是否已经加入受管列表
    pub managed: bool,
}

/// Codex 的项目信任状态。只读 `~/.codex/config.toml`，从不写。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexTrust {
    /// 显式 `trust_level = "trusted"`
    Trusted,
    /// 显式 `trust_level = "untrusted"`
    Untrusted,
    /// 配置里没有这个项目的条目
    Unknown,
}

/// 单个条目在某应用下的三个事实，界面据此渲染三态格子
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCell {
    /// 项目级已绑定（这条是 CC Switch 写进仓库的）
    pub bound: bool,
    /// 全局已启用（继承态；项目级再写一份会覆盖全局那份）
    pub global: bool,
    /// 仓库里已存在同名条目，但不是 CC Switch 写的——拒绝覆盖
    pub foreign: bool,
}

/// 一行（一个 MCP server 或一个 Skill）在这个项目里的状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemState {
    pub id: String,
    pub name: String,
    pub claude: ProjectCell,
    pub codex: ProjectCell,
}

/// 仓库里存在、但 CC Switch 不认识的条目（只报告，不动它）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignEntry {
    /// `mcp` | `skill`
    pub kind: String,
    pub app: String,
    pub key: String,
}

/// 面板一次拉取的全部状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScopeState {
    pub project: ScopedProject,
    pub mcp: Vec<ProjectItemState>,
    pub skills: Vec<ProjectItemState>,
    /// Codex 项目 MCP 只在受信任项目里生效；不信任时界面要提示用户自己去信任
    pub codex_trust: CodexTrust,
    pub foreign: Vec<ForeignEntry>,
    /// 会写到仓库里的文件/目录，界面上明示「这些会进版本库」
    pub targets: ProjectTargets,
}

/// 这个项目里 CC Switch 会碰的路径（给界面展示用，显示为相对路径）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTargets {
    pub claude_mcp: String,
    pub claude_approval: String,
    pub claude_skills: String,
    pub codex_mcp: String,
    pub codex_skills: String,
}

impl Default for ProjectTargets {
    fn default() -> Self {
        Self {
            claude_mcp: ".mcp.json".into(),
            claude_approval: ".claude/settings.local.json".into(),
            claude_skills: ".claude/skills/".into(),
            codex_mcp: ".codex/config.toml".into(),
            codex_skills: ".agents/skills/".into(),
        }
    }
}

/// 一次全量重投的结果
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncReport {
    pub applied: usize,
    /// 逐条失败原因（某个 Skill 的 SSOT 不见了、某个文件没权限写……）
    pub failures: Vec<ResyncFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncFailure {
    pub kind: String,
    pub item_id: String,
    pub app: String,
    pub error: String,
}

// ======================= 路径 =======================

/// `<repo>/.mcp.json`
pub fn claude_mcp_path(root: &Path) -> PathBuf {
    root.join(".mcp.json")
}

/// `<repo>/.claude/settings.local.json`
///
/// 预批准写在 local 而不是 `.claude/settings.json`：后者会进版本库，而被信任
/// 判定挡住的克隆仓库里它会被忽略，个人审批也不该提交给队友。
pub fn claude_approval_path(root: &Path) -> PathBuf {
    root.join(".claude").join("settings.local.json")
}

/// `<repo>/.claude/skills`
pub fn claude_skills_dir(root: &Path) -> PathBuf {
    root.join(".claude").join("skills")
}

/// `<repo>/.codex/config.toml`
pub fn codex_config_path(root: &Path) -> PathBuf {
    root.join(".codex").join("config.toml")
}

/// `<repo>/.agents/skills`——Codex 现行的 skills 约定
pub fn codex_skills_dir(root: &Path) -> PathBuf {
    root.join(".agents").join("skills")
}

fn skills_dir_for(root: &Path, app: ProjectApp) -> PathBuf {
    match app {
        ProjectApp::Claude => claude_skills_dir(root),
        ProjectApp::Codex => codex_skills_dir(root),
    }
}

// ======================= 服务 =======================

pub struct ProjectScopeService;

impl ProjectScopeService {
    /// 规范化用户给的项目路径：必须是已存在的目录，返回绝对路径
    pub fn normalize_path(raw: &str) -> Result<PathBuf, AppError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidInput("项目路径不能为空".into()));
        }
        let path = PathBuf::from(trimmed);
        if !path.is_absolute() {
            return Err(AppError::InvalidInput(format!(
                "项目路径必须是绝对路径: {trimmed}"
            )));
        }
        if !path.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "项目目录不存在或不是目录: {trimmed}"
            )));
        }
        // canonicalize 消掉 `..`、符号链接和盘符大小写差异，避免同一个仓库被加两次。
        // Windows 上它会带 `\\?\` 前缀，去掉以免显示和拼接都变丑。
        let canonical = fs::canonicalize(&path).map_err(|e| AppError::io(&path, e))?;
        Ok(strip_unc_prefix(canonical))
    }

    /// 项目 id：规范化路径的 sha256 前 16 位。Windows 路径大小写不敏感，先归一化
    /// 成小写再 hash，否则 `D:\Repo` 与 `d:\repo` 会变成两个项目。
    pub fn project_id(path: &Path) -> String {
        let text = path.to_string_lossy();
        #[cfg(windows)]
        let text = text.to_lowercase();
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        format!("{:x}", hasher.finalize())[..16].to_string()
    }

    /// 目录名当默认显示名；根目录这种没名字的回退到完整路径
    fn default_name(path: &Path) -> String {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string())
    }

    pub fn list_projects(db: &Arc<Database>) -> Result<Vec<ScopedProject>, AppError> {
        Ok(db
            .list_scoped_projects()?
            .into_iter()
            .map(ScopedProject::from_row)
            .collect())
    }

    /// 加入一个受管项目（同一路径重复加是幂等的，返回已有记录）
    pub fn add_project(db: &Arc<Database>, raw_path: &str) -> Result<ScopedProject, AppError> {
        let path = Self::normalize_path(raw_path)?;
        let path_text = path.to_string_lossy().to_string();
        if let Some(existing) = db.get_scoped_project_by_path(&path_text)? {
            return Ok(ScopedProject::from_row(existing));
        }
        let row = ScopedProjectRow {
            id: Self::project_id(&path),
            path: path_text,
            name: Self::default_name(&path),
            added_at: chrono::Utc::now().timestamp(),
        };
        db.upsert_scoped_project(&row)?;
        log::info!("项目级作用域：加入项目 {}", row.path);
        Ok(ScopedProject::from_row(row))
    }

    pub fn rename_project(db: &Arc<Database>, id: &str, name: &str) -> Result<bool, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("项目名不能为空".into()));
        }
        db.rename_scoped_project(id, name)
    }

    /// 移出受管列表。`cleanup` 为真时先把该项目里 CC Switch 写过的东西全部撤掉，
    /// 否则只删绑定记录、仓库里的文件原样留下（用户想保留已生成的配置时用）。
    pub fn remove_project(
        db: &Arc<Database>,
        id: &str,
        cleanup: bool,
    ) -> Result<Vec<ResyncFailure>, AppError> {
        let Some(row) = db.get_scoped_project(id)? else {
            return Err(AppError::InvalidInput(format!("项目不存在: {id}")));
        };
        let mut failures = Vec::new();
        if cleanup {
            let root = PathBuf::from(&row.path);
            for binding in db.list_project_bindings(id)? {
                let app = match ProjectApp::parse(&binding.app) {
                    Ok(app) => app,
                    Err(_) => continue,
                };
                let outcome = match binding.kind.as_str() {
                    KIND_MCP => Self::detach_mcp_file(&root, app, &binding.item_id),
                    KIND_SKILL => Self::detach_skill_file(db, &root, app, &binding.item_id),
                    _ => Ok(()),
                };
                if let Err(error) = outcome {
                    failures.push(ResyncFailure {
                        kind: binding.kind.clone(),
                        item_id: binding.item_id.clone(),
                        app: binding.app.clone(),
                        error: error.to_string(),
                    });
                }
            }
        }
        db.delete_scoped_project(id)?;
        log::info!("项目级作用域：移出项目 {}（cleanup={cleanup}）", row.path);
        Ok(failures)
    }

    /// 从会话历史里发现候选项目目录。只看 Claude Code 与 Codex 的会话。
    pub fn discover_candidates(db: &Arc<Database>) -> Result<Vec<ProjectCandidate>, AppError> {
        let managed: BTreeSet<String> = db
            .list_scoped_projects()?
            .into_iter()
            .map(|row| row.path)
            .collect();

        // provider_id → 项目级应用。会话模块用的就是这两个 id。
        let mut grouped: BTreeMap<String, (BTreeSet<String>, Option<i64>)> = BTreeMap::new();
        for session in crate::session_manager::scan_sessions() {
            let app = match session.provider_id.as_str() {
                "claude" => "claude",
                "codex" => "codex",
                _ => continue,
            };
            let Some(dir) = session.project_dir.as_deref() else {
                continue;
            };
            let path = PathBuf::from(dir);
            if !path.is_dir() {
                continue;
            }
            let key = fs::canonicalize(&path)
                .map(strip_unc_prefix)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();
            let entry = grouped.entry(key).or_default();
            entry.0.insert(app.to_string());
            if let Some(active) = session.last_active_at {
                entry.1 = Some(entry.1.map_or(active, |current: i64| current.max(active)));
            }
        }

        let mut out: Vec<ProjectCandidate> = grouped
            .into_iter()
            .map(|(path, (apps, last_active_at))| {
                let as_path = PathBuf::from(&path);
                ProjectCandidate {
                    name: Self::default_name(&as_path),
                    managed: managed.contains(&path),
                    path,
                    apps: apps.into_iter().collect(),
                    last_active_at,
                }
            })
            .collect();
        // 最近活跃的排前面，没有时间戳的垫底
        out.sort_by(|left, right| {
            right
                .last_active_at
                .unwrap_or(i64::MIN)
                .cmp(&left.last_active_at.unwrap_or(i64::MIN))
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(out)
    }

    // ======================= 状态读取 =======================

    /// 读一个项目的完整状态：每个 MCP / Skill 在两个应用下的三态，加上 Codex 信任
    /// 状态和仓库里那些「不是我们写的」条目。
    pub fn read_state(db: &Arc<Database>, project_id: &str) -> Result<ProjectScopeState, AppError> {
        let Some(row) = db.get_scoped_project(project_id)? else {
            return Err(AppError::InvalidInput(format!("项目不存在: {project_id}")));
        };
        let root = PathBuf::from(&row.path);
        let bindings = db.list_project_bindings(project_id)?;

        let bound: BTreeSet<(String, String, String)> = bindings
            .iter()
            .map(|binding| {
                (
                    binding.kind.clone(),
                    binding.item_id.clone(),
                    binding.app.clone(),
                )
            })
            .collect();

        // 仓库里现有的键
        let mut present: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        for app in ProjectApp::all() {
            present.insert(
                (KIND_MCP.to_string(), app.as_str().to_string()),
                read_mcp_keys(&root, app)?,
            );
            present.insert(
                (KIND_SKILL.to_string(), app.as_str().to_string()),
                read_skill_dirs(&root, app),
            );
        }

        let mut foreign = Vec::new();

        // ---- MCP 行 ----
        let servers = db.get_all_mcp_servers()?;
        let mut mcp_rows = Vec::new();
        let mut known_mcp_keys: BTreeSet<String> = BTreeSet::new();
        for (id, server) in servers.iter() {
            known_mcp_keys.insert(id.clone());
            let mut cells = Vec::new();
            for app in ProjectApp::all() {
                let is_bound =
                    bound.contains(&(KIND_MCP.to_string(), id.clone(), app.as_str().to_string()));
                let in_file = present
                    .get(&(KIND_MCP.to_string(), app.as_str().to_string()))
                    .is_some_and(|keys| keys.contains(id));
                cells.push(ProjectCell {
                    bound: is_bound,
                    global: server.apps.is_enabled_for(&app.app_type()),
                    foreign: in_file && !is_bound,
                });
            }
            mcp_rows.push(ProjectItemState {
                id: id.clone(),
                name: server.name.clone(),
                claude: cells[0].clone(),
                codex: cells[1].clone(),
            });
        }

        // ---- Skills 行 ----
        let skills = db.get_all_installed_skills()?;
        let mut skill_rows = Vec::new();
        let mut known_skill_dirs: BTreeSet<String> = BTreeSet::new();
        for (id, skill) in skills.iter() {
            known_skill_dirs.insert(skill.directory.clone());
            let mut cells = Vec::new();
            for app in ProjectApp::all() {
                let is_bound =
                    bound.contains(&(KIND_SKILL.to_string(), id.clone(), app.as_str().to_string()));
                let in_file = present
                    .get(&(KIND_SKILL.to_string(), app.as_str().to_string()))
                    .is_some_and(|dirs| dirs.contains(&skill.directory));
                cells.push(ProjectCell {
                    bound: is_bound,
                    global: skill.apps.is_enabled_for(&app.app_type()),
                    foreign: in_file && !is_bound,
                });
            }
            skill_rows.push(ProjectItemState {
                id: id.clone(),
                name: skill.name.clone(),
                claude: cells[0].clone(),
                codex: cells[1].clone(),
            });
        }

        // ---- 仓库里完全不认识的条目 ----
        for app in ProjectApp::all() {
            if let Some(keys) = present.get(&(KIND_MCP.to_string(), app.as_str().to_string())) {
                for key in keys.difference(&known_mcp_keys) {
                    foreign.push(ForeignEntry {
                        kind: KIND_MCP.to_string(),
                        app: app.as_str().to_string(),
                        key: key.clone(),
                    });
                }
            }
            if let Some(dirs) = present.get(&(KIND_SKILL.to_string(), app.as_str().to_string())) {
                for dir in dirs.difference(&known_skill_dirs) {
                    foreign.push(ForeignEntry {
                        kind: KIND_SKILL.to_string(),
                        app: app.as_str().to_string(),
                        key: dir.clone(),
                    });
                }
            }
        }

        Ok(ProjectScopeState {
            project: ScopedProject::from_row(row),
            mcp: mcp_rows,
            skills: skill_rows,
            codex_trust: read_codex_trust(&root),
            foreign,
            targets: ProjectTargets::default(),
        })
    }

    // ======================= 开关 =======================

    /// 勾选/取消一个 MCP server 在某项目某应用下的绑定
    pub fn toggle_mcp(
        db: &Arc<Database>,
        project_id: &str,
        server_id: &str,
        app: ProjectApp,
        enabled: bool,
    ) -> Result<(), AppError> {
        let root = Self::require_project_root(db, project_id)?;
        if enabled {
            let servers = db.get_all_mcp_servers()?;
            let server = servers
                .get(server_id)
                .ok_or_else(|| AppError::InvalidInput(format!("MCP 服务器不存在: {server_id}")))?;
            let already_bound = Self::is_bound(db, project_id, KIND_MCP, server_id, app)?;
            if !already_bound {
                // 文件里已有同名键却没有绑定记录 → 是别人的，拒绝覆盖
                ensure_not_foreign_mcp(&root, app, server_id)?;
            }
            let spec = server.server.clone();
            crate::mcp::validation::validate_server_spec(&spec)?;
            Self::attach_mcp_file(&root, app, server_id, &spec)?;
            db.add_project_binding(
                project_id,
                KIND_MCP,
                server_id,
                app.as_str(),
                chrono::Utc::now().timestamp(),
            )?;
            log::info!(
                "项目级作用域：MCP {server_id} 已绑定到 {} 的 {}",
                root.display(),
                app.as_str()
            );
        } else {
            Self::detach_mcp_file(&root, app, server_id)?;
            db.remove_project_binding(project_id, KIND_MCP, server_id, app.as_str())?;
            log::info!(
                "项目级作用域：MCP {server_id} 已从 {} 的 {} 解绑",
                root.display(),
                app.as_str()
            );
        }
        Ok(())
    }

    /// 勾选/取消一个 Skill 在某项目某应用下的绑定
    pub fn toggle_skill(
        db: &Arc<Database>,
        project_id: &str,
        skill_id: &str,
        app: ProjectApp,
        enabled: bool,
    ) -> Result<(), AppError> {
        let root = Self::require_project_root(db, project_id)?;
        if enabled {
            let skill = db
                .get_installed_skill(skill_id)?
                .ok_or_else(|| AppError::InvalidInput(format!("Skill 不存在: {skill_id}")))?;
            let already_bound = Self::is_bound(db, project_id, KIND_SKILL, skill_id, app)?;
            if !already_bound {
                ensure_not_foreign_skill(&root, app, &skill.directory)?;
            }
            let dest_dir = skills_dir_for(&root, app);
            SkillService::sync_directory_into(&skill.directory, &dest_dir)
                .map_err(|e| AppError::Config(e.to_string()))?;
            db.add_project_binding(
                project_id,
                KIND_SKILL,
                skill_id,
                app.as_str(),
                chrono::Utc::now().timestamp(),
            )?;
            log::info!(
                "项目级作用域：Skill {skill_id} 已绑定到 {}",
                dest_dir.display()
            );
        } else {
            Self::detach_skill_file(db, &root, app, skill_id)?;
            db.remove_project_binding(project_id, KIND_SKILL, skill_id, app.as_str())?;
            log::info!(
                "项目级作用域：Skill {skill_id} 已从 {} 的 {} 解绑",
                root.display(),
                app.as_str()
            );
        }
        Ok(())
    }

    /// 按库里的绑定全量重投一次（修复手改/误删造成的漂移）
    pub fn resync(db: &Arc<Database>, project_id: &str) -> Result<ResyncReport, AppError> {
        let root = Self::require_project_root(db, project_id)?;
        let servers = db.get_all_mcp_servers()?;
        let mut report = ResyncReport::default();

        for binding in db.list_project_bindings(project_id)? {
            let app = match ProjectApp::parse(&binding.app) {
                Ok(app) => app,
                Err(error) => {
                    report.failures.push(ResyncFailure {
                        kind: binding.kind.clone(),
                        item_id: binding.item_id.clone(),
                        app: binding.app.clone(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            let outcome = match binding.kind.as_str() {
                KIND_MCP => match servers.get(&binding.item_id) {
                    Some(server) => crate::mcp::validation::validate_server_spec(&server.server)
                        .and_then(|()| {
                            Self::attach_mcp_file(&root, app, &binding.item_id, &server.server)
                        }),
                    None => Err(AppError::InvalidInput(format!(
                        "MCP 服务器已不存在: {}",
                        binding.item_id
                    ))),
                },
                KIND_SKILL => match db.get_installed_skill(&binding.item_id)? {
                    Some(skill) => SkillService::sync_directory_into(
                        &skill.directory,
                        &skills_dir_for(&root, app),
                    )
                    .map_err(|e| AppError::Config(e.to_string())),
                    None => Err(AppError::InvalidInput(format!(
                        "Skill 已不存在: {}",
                        binding.item_id
                    ))),
                },
                other => Err(AppError::InvalidInput(format!("未知绑定种类: {other}"))),
            };
            match outcome {
                Ok(()) => report.applied += 1,
                Err(error) => report.failures.push(ResyncFailure {
                    kind: binding.kind,
                    item_id: binding.item_id,
                    app: binding.app,
                    error: error.to_string(),
                }),
            }
        }
        Ok(report)
    }

    /// 条目在全局被卸载时，连带把它在各项目里的投影和绑定一并撤掉
    pub fn purge_item(
        db: &Arc<Database>,
        kind_is_skill: bool,
        item_id: &str,
    ) -> Result<(), AppError> {
        let kind = if kind_is_skill { KIND_SKILL } else { KIND_MCP };
        for binding in db.list_all_project_bindings()? {
            if binding.kind != kind || binding.item_id != item_id {
                continue;
            }
            let Some(project) = db.get_scoped_project(&binding.project_id)? else {
                continue;
            };
            let Ok(app) = ProjectApp::parse(&binding.app) else {
                continue;
            };
            let root = PathBuf::from(&project.path);
            let outcome = if kind_is_skill {
                Self::detach_skill_file(db, &root, app, item_id)
            } else {
                Self::detach_mcp_file(&root, app, item_id)
            };
            if let Err(error) = outcome {
                log::warn!(
                    "项目级作用域：撤销 {item_id} 在 {} 的投影失败: {error}",
                    project.path
                );
            }
        }
        db.remove_project_bindings_for_item(kind, item_id)?;
        Ok(())
    }

    // ======================= 内部 =======================

    fn require_project_root(db: &Arc<Database>, project_id: &str) -> Result<PathBuf, AppError> {
        let Some(row) = db.get_scoped_project(project_id)? else {
            return Err(AppError::InvalidInput(format!("项目不存在: {project_id}")));
        };
        let root = PathBuf::from(&row.path);
        if !root.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "项目目录已不存在: {}",
                row.path
            )));
        }
        Ok(root)
    }

    fn is_bound(
        db: &Arc<Database>,
        project_id: &str,
        kind: &str,
        item_id: &str,
        app: ProjectApp,
    ) -> Result<bool, AppError> {
        Ok(db
            .list_project_bindings(project_id)?
            .iter()
            .any(|binding: &ProjectBindingRow| {
                binding.kind == kind && binding.item_id == item_id && binding.app == app.as_str()
            }))
    }

    fn attach_mcp_file(
        root: &Path,
        app: ProjectApp,
        id: &str,
        spec: &Value,
    ) -> Result<(), AppError> {
        match app {
            ProjectApp::Claude => {
                upsert_claude_project_mcp(root, id, spec)?;
                approve_claude_project_mcp(root, id)
            }
            ProjectApp::Codex => upsert_codex_project_mcp(root, id, spec),
        }
    }

    fn detach_mcp_file(root: &Path, app: ProjectApp, id: &str) -> Result<(), AppError> {
        match app {
            ProjectApp::Claude => {
                remove_claude_project_mcp(root, id)?;
                unapprove_claude_project_mcp(root, id)?;
                // 预批准文件删掉后 `.claude/` 可能空了，它是我们建的，一并收走
                prune_empty_dirs_up_to(root, claude_approval_path(root).parent().unwrap_or(root));
                Ok(())
            }
            ProjectApp::Codex => {
                remove_codex_project_mcp(root, id)?;
                prune_empty_dirs_up_to(root, codex_config_path(root).parent().unwrap_or(root));
                Ok(())
            }
        }
    }

    fn detach_skill_file(
        db: &Arc<Database>,
        root: &Path,
        app: ProjectApp,
        skill_id: &str,
    ) -> Result<(), AppError> {
        // 目录名存在 skills 表里；条目已被删除时无从得知目录名，只能跳过文件侧。
        let Some(skill) = db.get_installed_skill(skill_id)? else {
            log::warn!("项目级作用域：Skill {skill_id} 已不在库中，跳过文件撤销");
            return Ok(());
        };
        let dest_dir = skills_dir_for(root, app);
        SkillService::remove_directory_from(&skill.directory, &dest_dir)
            .map_err(|e| AppError::Config(e.to_string()))?;
        // remove_directory_from 只收走空的 skills 目录；`.claude/`、`.agents/`
        // 这层也是我们建的，空了就别留在人家仓库里
        prune_empty_dirs_up_to(root, &dest_dir);
        Ok(())
    }
}

// ======================= 文件读写 =======================

/// 去掉 Windows canonicalize 带的 `\\?\` 前缀
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// 读一个 JSON 文件；不存在当空对象，内容坏了如实报错（绝不覆盖用户文件）
fn read_json_object(path: &Path) -> Result<Map<String, Value>, AppError> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path).map_err(|e| AppError::io(path, e))?;
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_str(&text).map_err(|source| AppError::Json {
        path: path.display().to_string(),
        source,
    })?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(AppError::InvalidInput(format!(
            "{} 的顶层不是 JSON 对象，拒绝改写",
            path.display()
        ))),
    }
}

fn write_json_object(path: &Path, map: &Map<String, Value>) -> Result<(), AppError> {
    let text = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|source| AppError::JsonSerialize { source })?;
    crate::config::write_text_file(path, &format!("{text}\n"))
}

/// 从 `start` 往上逐层删掉**空**目录，直到 `root`（不含）为止。
///
/// 撤销要连我们建出来的 `.claude/`、`.codex/`、`.agents/` 一起收走：只删空目录，
/// 所以用户原本就有内容的 `.claude/` 不会被碰。git 不跟踪空目录，留着纯属在
/// 别人仓库里积垢。
fn prune_empty_dirs_up_to(root: &Path, start: &Path) {
    let mut current = start.to_path_buf();
    while current != root && current.starts_with(root) {
        // start 常常是刚被删掉的目录（skills 目录自己已由调用方收走），
        // 读不到就继续往上看它的父目录，而不是就此收手。
        if current.exists() {
            let is_empty = match fs::read_dir(&current) {
                Ok(mut entries) => entries.next().is_none(),
                Err(_) => return,
            };
            if !is_empty || fs::remove_dir(&current).is_err() {
                return;
            }
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return,
        }
    }
}

/// 文件空了就删掉，不在用户仓库里留空壳
fn remove_file_if_present(path: &Path) -> Result<(), AppError> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| AppError::io(path, e))?;
    }
    Ok(())
}

fn mcp_servers_map(map: &Map<String, Value>) -> Option<&Map<String, Value>> {
    map.get("mcpServers").and_then(Value::as_object)
}

/// 写入 `<repo>/.mcp.json` 的 `mcpServers.<id>`，其余键原样保留
fn upsert_claude_project_mcp(root: &Path, id: &str, spec: &Value) -> Result<(), AppError> {
    let path = claude_mcp_path(root);
    let mut map = read_json_object(&path)?;
    let servers = match map.get_mut("mcpServers") {
        Some(Value::Object(servers)) => servers,
        Some(other) if !other.is_null() => {
            return Err(AppError::InvalidInput(format!(
                "{} 的 mcpServers 不是对象，拒绝改写",
                path.display()
            )));
        }
        _ => {
            map.insert("mcpServers".to_string(), json!({}));
            map.get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .expect("just inserted an object")
        }
    };
    servers.insert(id.to_string(), spec.clone());
    write_json_object(&path, &map)
}

fn remove_claude_project_mcp(root: &Path, id: &str) -> Result<(), AppError> {
    let path = claude_mcp_path(root);
    if !path.exists() {
        return Ok(());
    }
    let mut map = read_json_object(&path)?;
    let Some(Value::Object(servers)) = map.get_mut("mcpServers") else {
        return Ok(());
    };
    servers.remove(id);
    if servers.is_empty() {
        map.remove("mcpServers");
    }
    if map.is_empty() {
        return remove_file_if_present(&path);
    }
    write_json_object(&path, &map)
}

/// 在 `<repo>/.claude/settings.local.json` 的 `enabledMcpjsonServers` 里加上名字，
/// 省掉交互式会话里的审批弹窗。这是项目内文件，不是全局配置。
fn approve_claude_project_mcp(root: &Path, id: &str) -> Result<(), AppError> {
    let path = claude_approval_path(root);
    let mut map = read_json_object(&path)?;
    let list = match map.get_mut("enabledMcpjsonServers") {
        Some(Value::Array(list)) => list,
        Some(other) if !other.is_null() => {
            return Err(AppError::InvalidInput(format!(
                "{} 的 enabledMcpjsonServers 不是数组，拒绝改写",
                path.display()
            )));
        }
        _ => {
            map.insert("enabledMcpjsonServers".to_string(), json!([]));
            map.get_mut("enabledMcpjsonServers")
                .and_then(Value::as_array_mut)
                .expect("just inserted an array")
        }
    };
    if !list.iter().any(|item| item.as_str() == Some(id)) {
        list.push(Value::String(id.to_string()));
    }
    write_json_object(&path, &map)
}

fn unapprove_claude_project_mcp(root: &Path, id: &str) -> Result<(), AppError> {
    let path = claude_approval_path(root);
    if !path.exists() {
        return Ok(());
    }
    let mut map = read_json_object(&path)?;
    let Some(Value::Array(list)) = map.get_mut("enabledMcpjsonServers") else {
        return Ok(());
    };
    list.retain(|item| item.as_str() != Some(id));
    if list.is_empty() {
        map.remove("enabledMcpjsonServers");
    }
    if map.is_empty() {
        return remove_file_if_present(&path);
    }
    write_json_object(&path, &map)
}

/// 读 `<repo>/.codex/config.toml`；不存在当空文档，语法坏了如实报错
fn read_codex_project_doc(path: &Path) -> Result<toml_edit::DocumentMut, AppError> {
    if !path.exists() {
        return Ok(toml_edit::DocumentMut::default());
    }
    let text = fs::read_to_string(path).map_err(|e| AppError::io(path, e))?;
    if text.trim().is_empty() {
        return Ok(toml_edit::DocumentMut::default());
    }
    text.parse::<toml_edit::DocumentMut>()
        .map_err(|e| AppError::McpValidation(format!("解析 {} 失败: {e}", path.display())))
}

/// 写入 `<repo>/.codex/config.toml` 的 `[mcp_servers.<id>]`，其余键原样保留
fn upsert_codex_project_mcp(root: &Path, id: &str, spec: &Value) -> Result<(), AppError> {
    let path = codex_config_path(root);
    let mut doc = read_codex_project_doc(&path)?;
    let table = crate::mcp::codex::json_server_to_codex_toml_table(spec)?;

    if doc
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_like_mut)
        .is_none()
    {
        if doc.get("mcp_servers").is_some_and(|item| !item.is_none()) {
            return Err(AppError::InvalidInput(format!(
                "{} 的 mcp_servers 不是表，拒绝改写",
                path.display()
            )));
        }
        doc["mcp_servers"] = toml_edit::table();
    }
    let servers = doc
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or_else(|| {
            AppError::InvalidInput(format!("{} 的 mcp_servers 不是表", path.display()))
        })?;
    servers.insert(id, toml_edit::Item::Table(table));

    crate::config::write_text_file(&path, &doc.to_string())
}

fn remove_codex_project_mcp(root: &Path, id: &str) -> Result<(), AppError> {
    let path = codex_config_path(root);
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_codex_project_doc(&path)?;
    let mut emptied = false;
    if let Some(servers) = doc
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_like_mut)
    {
        servers.remove(id);
        emptied = servers.is_empty();
    }
    if emptied {
        doc.as_table_mut().remove("mcp_servers");
    }
    if doc.as_table().is_empty() {
        return remove_file_if_present(&path);
    }
    crate::config::write_text_file(&path, &doc.to_string())
}

/// 仓库里现有的 MCP 键
fn read_mcp_keys(root: &Path, app: ProjectApp) -> Result<BTreeSet<String>, AppError> {
    match app {
        ProjectApp::Claude => {
            let path = claude_mcp_path(root);
            if !path.exists() {
                return Ok(BTreeSet::new());
            }
            // 读状态不该因为一个坏文件就让整个面板打不开
            let Ok(map) = read_json_object(&path) else {
                return Ok(BTreeSet::new());
            };
            Ok(mcp_servers_map(&map)
                .map(|servers| servers.keys().cloned().collect())
                .unwrap_or_default())
        }
        ProjectApp::Codex => {
            let path = codex_config_path(root);
            if !path.exists() {
                return Ok(BTreeSet::new());
            }
            let Ok(doc) = read_codex_project_doc(&path) else {
                return Ok(BTreeSet::new());
            };
            Ok(doc
                .get("mcp_servers")
                .and_then(toml_edit::Item::as_table_like)
                .map(|servers| {
                    servers
                        .iter()
                        .map(|(key, _)| key.to_string())
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default())
        }
    }
}

/// 仓库里现有的 skill 目录名
fn read_skill_dirs(root: &Path, app: ProjectApp) -> BTreeSet<String> {
    let dir = skills_dir_for(root, app);
    let Ok(entries) = fs::read_dir(&dir) else {
        return BTreeSet::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect()
}

fn ensure_not_foreign_mcp(root: &Path, app: ProjectApp, id: &str) -> Result<(), AppError> {
    if read_mcp_keys(root, app)?.contains(id) {
        let file = match app {
            ProjectApp::Claude => claude_mcp_path(root),
            ProjectApp::Codex => codex_config_path(root),
        };
        return Err(AppError::InvalidInput(format!(
            "{} 里已有名为 {id} 的 MCP 服务器，且不是 CC Switch 写入的；\
             请先在仓库里改名或删除它，以免覆盖手写/队友提交的配置",
            file.display()
        )));
    }
    Ok(())
}

fn ensure_not_foreign_skill(root: &Path, app: ProjectApp, directory: &str) -> Result<(), AppError> {
    let dir = skills_dir_for(root, app);
    let dest = dir.join(directory);
    if dest.exists() {
        return Err(AppError::InvalidInput(format!(
            "{} 已存在，且不是 CC Switch 写入的；请先在仓库里改名或删除它",
            dest.display()
        )));
    }
    Ok(())
}

/// 只读地判断 Codex 是否信任这个项目。
///
/// Codex 只在受信任的项目里加载 `.codex/` 层（项目 MCP 也在内）。信任状态记在
/// 用户级 `~/.codex/config.toml` 的 `projects."<path>".trust_level`——那是全局
/// 配置，本功能只读不写，不信任时由界面提示用户自己处理。
fn read_codex_trust(root: &Path) -> CodexTrust {
    let path = crate::codex_config::get_codex_config_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return CodexTrust::Unknown;
    };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return CodexTrust::Unknown;
    };
    let Some(projects) = doc.get("projects").and_then(toml_edit::Item::as_table_like) else {
        return CodexTrust::Unknown;
    };

    let target = root.to_string_lossy();
    for (key, item) in projects.iter() {
        if !same_project_path(key, &target) {
            continue;
        }
        let level = item
            .as_table_like()
            .and_then(|table| table.get("trust_level"))
            .and_then(|value| value.as_str());
        return match level {
            Some("trusted") => CodexTrust::Trusted,
            Some("untrusted") => CodexTrust::Untrusted,
            _ => CodexTrust::Unknown,
        };
    }
    CodexTrust::Unknown
}

/// 路径比较：Windows 下大小写不敏感，且统一分隔符
fn same_project_path(left: &str, right: &str) -> bool {
    let normalize = |raw: &str| {
        let unified = raw.replace('\\', "/");
        let trimmed = unified.trim_end_matches('/').to_string();
        #[cfg(windows)]
        let trimmed = trimmed.to_lowercase();
        trimmed
    };
    normalize(left) == normalize(right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::{InstalledSkill, McpApps, McpServer, SkillApps};
    use std::ffi::OsString;
    use tempfile::{tempdir, TempDir};

    /// 把 HOME 指到临时目录，保证测试看不见真实用户目录
    struct HomeGuard {
        previous: Option<OsString>,
    }

    impl HomeGuard {
        fn set(home: &Path) -> Self {
            let guard = Self {
                previous: std::env::var_os("CC_SWITCH_TEST_HOME"),
            };
            std::env::set_var("CC_SWITCH_TEST_HOME", home);
            guard
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    struct Fixture {
        home: TempDir,
        _guard: HomeGuard,
        repo: TempDir,
        db: Arc<Database>,
        project_id: String,
    }

    fn setup() -> Fixture {
        let home = tempdir().expect("home");
        let guard = HomeGuard::set(home.path());
        let repo = tempdir().expect("repo");
        let db = Arc::new(Database::memory().expect("memory db"));
        let project = ProjectScopeService::add_project(&db, &repo.path().to_string_lossy())
            .expect("add project");
        Fixture {
            home,
            _guard: guard,
            repo,
            db,
            project_id: project.id,
        }
    }

    /// add_project 存的是 canonicalize 后的路径，断言要用同一个形态
    fn repo_root(fixture: &Fixture) -> PathBuf {
        strip_unc_prefix(fs::canonicalize(fixture.repo.path()).expect("canonicalize repo"))
    }

    fn seed_server(db: &Arc<Database>, id: &str, apps: McpApps) {
        db.save_mcp_server(&McpServer {
            id: id.to_string(),
            name: format!("{id} server"),
            server: json!({ "command": "npx", "args": ["-y", "demo-mcp"] }),
            apps,
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save server");
    }

    fn seed_skill(db: &Arc<Database>, id: &str, directory: &str, apps: SkillApps) {
        let ssot = SkillService::get_ssot_dir().expect("ssot dir");
        let dir = ssot.join(directory);
        fs::create_dir_all(&dir).expect("create ssot skill dir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {directory}\ndescription: test\n---\n"),
        )
        .expect("write SKILL.md");

        db.save_skill(&InstalledSkill {
            id: id.to_string(),
            name: format!("{directory} skill"),
            description: None,
            directory: directory.to_string(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps,
            installed_at: 0,
            content_hash: None,
            updated_at: 0,
        })
        .expect("save skill");
    }

    #[test]
    #[serial_test::serial]
    fn claude_mcp_binding_writes_project_files_and_removes_them_again() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        let root = repo_root(&fixture);

        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Claude,
            true,
        )
        .expect("bind claude mcp");

        let mcp_file = claude_mcp_path(&root);
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&mcp_file).expect("read .mcp.json"))
                .expect("parse .mcp.json");
        assert_eq!(
            written["mcpServers"]["ctx7"]["command"],
            json!("npx"),
            "服务器定义要原样写进项目的 .mcp.json"
        );

        // 预批准落在项目内的 settings.local.json，而不是任何全局设置文件
        let approval: Value = serde_json::from_str(
            &fs::read_to_string(claude_approval_path(&root)).expect("read settings.local.json"),
        )
        .expect("parse settings.local.json");
        assert_eq!(approval["enabledMcpjsonServers"], json!(["ctx7"]));

        // 解绑后两个文件都不该留空壳
        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Claude,
            false,
        )
        .expect("unbind claude mcp");
        assert!(!mcp_file.exists(), ".mcp.json 空了就该删掉");
        assert!(
            !claude_approval_path(&root).exists(),
            "settings.local.json 空了就该删掉"
        );
    }

    #[test]
    #[serial_test::serial]
    fn codex_mcp_binding_writes_project_config_toml() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        let root = repo_root(&fixture);

        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Codex,
            true,
        )
        .expect("bind codex mcp");

        let config = codex_config_path(&root);
        let text = fs::read_to_string(&config).expect("read .codex/config.toml");
        assert!(
            text.contains("[mcp_servers.ctx7]"),
            "要写成 Codex 的 [mcp_servers.<id>] 表，实际内容: {text}"
        );

        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Codex,
            false,
        )
        .expect("unbind codex mcp");
        assert!(!config.exists(), "整份配置只剩空表时应删掉文件");
    }

    #[test]
    #[serial_test::serial]
    fn unrelated_project_content_survives_bind_and_unbind() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        let root = repo_root(&fixture);

        // 用户/队友手写的内容：另一个 server + 一个无关顶层键
        let mcp_file = claude_mcp_path(&root);
        fs::write(
            &mcp_file,
            "{\"mcpServers\":{\"teammate\":{\"command\":\"node\"}},\"$schema\":\"https://example.com/s.json\"}",
        )
        .expect("seed .mcp.json");
        let codex_file = codex_config_path(&root);
        fs::create_dir_all(codex_file.parent().expect("parent")).expect("mkdir .codex");
        fs::write(
            &codex_file,
            "model = \"gpt-5\"\n\n[mcp_servers.teammate]\ncommand = \"node\"\n",
        )
        .expect("seed config.toml");

        for app in ProjectApp::all() {
            ProjectScopeService::toggle_mcp(&fixture.db, &fixture.project_id, "ctx7", app, true)
                .expect("bind");
            ProjectScopeService::toggle_mcp(&fixture.db, &fixture.project_id, "ctx7", app, false)
                .expect("unbind");
        }

        let json_after: Value =
            serde_json::from_str(&fs::read_to_string(&mcp_file).expect("read json"))
                .expect("parse");
        assert_eq!(
            json_after["mcpServers"]["teammate"]["command"],
            json!("node")
        );
        assert_eq!(json_after["$schema"], json!("https://example.com/s.json"));
        assert!(json_after["mcpServers"].get("ctx7").is_none());

        let toml_after = fs::read_to_string(&codex_file).expect("read toml");
        assert!(toml_after.contains("model = \"gpt-5\""), "无关键必须留着");
        assert!(toml_after.contains("[mcp_servers.teammate]"));
        assert!(!toml_after.contains("[mcp_servers.ctx7]"));
    }

    #[test]
    #[serial_test::serial]
    fn refuses_to_overwrite_an_entry_cc_switch_did_not_write() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        let root = repo_root(&fixture);

        // 仓库里已有同名条目（队友提交的），且没有任何绑定记录
        let mcp_file = claude_mcp_path(&root);
        let original = "{\"mcpServers\":{\"ctx7\":{\"command\":\"their-own-binary\"}}}";
        fs::write(&mcp_file, original).expect("seed .mcp.json");

        let error = ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Claude,
            true,
        )
        .expect_err("同名外来条目必须拒绝写入");
        assert!(
            error.to_string().contains("ctx7"),
            "报错要点明是哪个条目: {error}"
        );
        assert_eq!(
            fs::read_to_string(&mcp_file).expect("read back"),
            original,
            "拒绝之后文件必须一个字节都没动"
        );
    }

    #[test]
    #[serial_test::serial]
    fn skill_binding_copies_into_claude_and_agents_directories() {
        let fixture = setup();
        seed_skill(&fixture.db, "local:helper", "helper", SkillApps::default());
        let root = repo_root(&fixture);

        for app in ProjectApp::all() {
            ProjectScopeService::toggle_skill(
                &fixture.db,
                &fixture.project_id,
                "local:helper",
                app,
                true,
            )
            .expect("bind skill");
        }

        // Claude 用 .claude/skills，Codex 用 .agents/skills（不是 .codex/skills）
        assert!(claude_skills_dir(&root)
            .join("helper")
            .join("SKILL.md")
            .is_file());
        assert!(codex_skills_dir(&root)
            .join("helper")
            .join("SKILL.md")
            .is_file());
        assert!(
            !root.join(".codex").join("skills").exists(),
            "不该再往已废弃的 .codex/skills 里写"
        );

        // 项目级固定用复制，不能是符号链接（提交进 git 对队友是坏链）
        let meta = fs::symlink_metadata(claude_skills_dir(&root).join("helper"))
            .expect("symlink metadata");
        assert!(!meta.file_type().is_symlink(), "项目级必须是真实副本");

        for app in ProjectApp::all() {
            ProjectScopeService::toggle_skill(
                &fixture.db,
                &fixture.project_id,
                "local:helper",
                app,
                false,
            )
            .expect("unbind skill");
        }
        assert!(!claude_skills_dir(&root).exists(), "空的 skills 目录要清掉");
        assert!(!codex_skills_dir(&root).exists(), "空的 skills 目录要清掉");
    }

    /// 真机联调发现的回归：解绑后 `.claude/`、`.agents/` 这两层空目录曾被留在
    /// 用户仓库里。撤销必须让仓库回到绑定前的样子。
    #[test]
    #[serial_test::serial]
    fn unbinding_leaves_the_repository_exactly_as_it_was() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        seed_skill(&fixture.db, "local:helper", "helper", SkillApps::default());
        let root = repo_root(&fixture);

        // 绑定前的样子：只有一个无关文件
        fs::write(
            root.join("README.md"),
            "hello
",
        )
        .expect("seed readme");
        let before = snapshot(&root);

        for app in ProjectApp::all() {
            ProjectScopeService::toggle_mcp(&fixture.db, &fixture.project_id, "ctx7", app, true)
                .expect("bind mcp");
            ProjectScopeService::toggle_skill(
                &fixture.db,
                &fixture.project_id,
                "local:helper",
                app,
                true,
            )
            .expect("bind skill");
        }
        assert_ne!(snapshot(&root), before, "绑定应当确实写了东西");

        for app in ProjectApp::all() {
            ProjectScopeService::toggle_mcp(&fixture.db, &fixture.project_id, "ctx7", app, false)
                .expect("unbind mcp");
            ProjectScopeService::toggle_skill(
                &fixture.db,
                &fixture.project_id,
                "local:helper",
                app,
                false,
            )
            .expect("unbind skill");
        }

        assert_eq!(
            snapshot(&root),
            before,
            "解绑后仓库必须回到原样，连空目录都不留"
        );
    }

    /// 仓库里所有路径（相对、排序），目录带尾斜杠
    fn snapshot(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let relative = path
                    .strip_prefix(root)
                    .map(|rest| {
                        rest.to_string_lossy()
                            .replace(std::path::MAIN_SEPARATOR, "/")
                    })
                    .unwrap_or_default();
                if path.is_dir() {
                    out.push(format!("{relative}/"));
                    walk(&path, root, out);
                } else {
                    out.push(relative);
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    #[test]
    #[serial_test::serial]
    fn state_reports_project_binding_global_inheritance_and_foreign_entries() {
        let fixture = setup();
        // 全局已启用给 Claude，项目级未绑定 → 继承态
        let mut claude_only = McpApps::default();
        claude_only.set_enabled_for(&AppType::Claude, true);
        seed_server(&fixture.db, "ctx7", claude_only);
        seed_skill(
            &fixture.db,
            "local:helper",
            "helper",
            SkillApps::only(&AppType::Codex),
        );
        let root = repo_root(&fixture);

        // 项目级给 Codex 绑一个 MCP
        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Codex,
            true,
        )
        .expect("bind codex mcp");

        // 仓库里塞一个 CC Switch 不认识的 skill
        let foreign_dir = claude_skills_dir(&root).join("not-ours");
        fs::create_dir_all(&foreign_dir).expect("mkdir foreign skill");
        fs::write(foreign_dir.join("SKILL.md"), "---\nname: not-ours\n---\n")
            .expect("write foreign SKILL.md");

        let state =
            ProjectScopeService::read_state(&fixture.db, &fixture.project_id).expect("read state");

        let server_row = state
            .mcp
            .iter()
            .find(|row| row.id == "ctx7")
            .expect("mcp row");
        assert!(server_row.claude.global, "全局启用要报成继承态");
        assert!(!server_row.claude.bound);
        assert!(server_row.codex.bound, "项目级绑定要报成已绑定");
        assert!(!server_row.codex.global);

        let skill_row = state
            .skills
            .iter()
            .find(|row| row.id == "local:helper")
            .expect("skill row");
        assert!(skill_row.codex.global);
        assert!(!skill_row.claude.bound);

        assert!(
            state.foreign.iter().any(|entry| entry.key == "not-ours"
                && entry.kind == "skill"
                && entry.app == "claude"),
            "仓库里不认识的条目要如实报出来: {:?}",
            state.foreign
        );
    }

    #[test]
    #[serial_test::serial]
    fn binding_never_touches_any_global_config() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        seed_skill(&fixture.db, "local:helper", "helper", SkillApps::default());
        let home = fixture.home.path().to_path_buf();

        // 这些全局文件在整个流程里既不能被创建，也不能被修改
        let globals = [
            home.join(".claude.json"),
            home.join(".claude").join("settings.json"),
            home.join(".claude").join("skills"),
            home.join(".codex").join("config.toml"),
            home.join(".codex").join("skills"),
            home.join(".agents").join("skills"),
        ];

        for app in ProjectApp::all() {
            ProjectScopeService::toggle_mcp(&fixture.db, &fixture.project_id, "ctx7", app, true)
                .expect("bind mcp");
            ProjectScopeService::toggle_skill(
                &fixture.db,
                &fixture.project_id,
                "local:helper",
                app,
                true,
            )
            .expect("bind skill");
        }
        ProjectScopeService::resync(&fixture.db, &fixture.project_id).expect("resync");

        for path in &globals {
            assert!(
                !path.exists(),
                "项目级作用域不得创建或改写全局配置，却碰了 {}",
                path.display()
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn codex_trust_is_read_from_the_user_config_without_writing_it() {
        let fixture = setup();
        let root = repo_root(&fixture);
        let user_config = crate::codex_config::get_codex_config_path();
        fs::create_dir_all(user_config.parent().expect("parent")).expect("mkdir .codex");
        let original = format!(
            "model = \"gpt-5\"\n\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
            root.to_string_lossy().replace('\\', "\\\\")
        );
        fs::write(&user_config, &original).expect("seed user config");

        seed_server(&fixture.db, "ctx7", McpApps::default());
        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Codex,
            true,
        )
        .expect("bind codex mcp");

        let state =
            ProjectScopeService::read_state(&fixture.db, &fixture.project_id).expect("read state");
        assert_eq!(state.codex_trust, CodexTrust::Trusted);
        assert_eq!(
            fs::read_to_string(&user_config).expect("read back"),
            original,
            "信任状态只读，用户级 config.toml 不得被改写"
        );
    }

    #[test]
    #[serial_test::serial]
    fn resync_reapplies_bindings_after_the_files_were_deleted_by_hand() {
        let fixture = setup();
        seed_server(&fixture.db, "ctx7", McpApps::default());
        seed_skill(&fixture.db, "local:helper", "helper", SkillApps::default());
        let root = repo_root(&fixture);

        ProjectScopeService::toggle_mcp(
            &fixture.db,
            &fixture.project_id,
            "ctx7",
            ProjectApp::Claude,
            true,
        )
        .expect("bind mcp");
        ProjectScopeService::toggle_skill(
            &fixture.db,
            &fixture.project_id,
            "local:helper",
            ProjectApp::Claude,
            true,
        )
        .expect("bind skill");

        // 手动把仓库里的投影删掉，模拟漂移
        fs::remove_file(claude_mcp_path(&root)).expect("rm .mcp.json");
        fs::remove_dir_all(claude_skills_dir(&root).join("helper")).expect("rm skill dir");

        let report = ProjectScopeService::resync(&fixture.db, &fixture.project_id).expect("resync");
        assert_eq!(report.applied, 2);
        assert!(report.failures.is_empty(), "失败项: {:?}", report.failures);
        assert!(claude_mcp_path(&root).is_file());
        assert!(claude_skills_dir(&root)
            .join("helper")
            .join("SKILL.md")
            .is_file());
    }

    #[test]
    #[serial_test::serial]
    fn purge_item_clears_bindings_and_project_files() {
        let fixture = setup();
        seed_skill(&fixture.db, "local:helper", "helper", SkillApps::default());
        let root = repo_root(&fixture);

        ProjectScopeService::toggle_skill(
            &fixture.db,
            &fixture.project_id,
            "local:helper",
            ProjectApp::Codex,
            true,
        )
        .expect("bind skill");
        assert!(codex_skills_dir(&root).join("helper").exists());

        ProjectScopeService::purge_item(&fixture.db, true, "local:helper").expect("purge");

        assert!(
            !codex_skills_dir(&root).join("helper").exists(),
            "卸载后仓库里的副本要撤掉"
        );
        assert!(
            fixture
                .db
                .list_project_bindings(&fixture.project_id)
                .expect("list bindings")
                .is_empty(),
            "绑定记录要一起清掉"
        );
    }

    #[test]
    #[serial_test::serial]
    fn adding_the_same_path_twice_is_idempotent() {
        let fixture = setup();
        let again =
            ProjectScopeService::add_project(&fixture.db, &fixture.repo.path().to_string_lossy())
                .expect("add again");
        assert_eq!(again.id, fixture.project_id);
        assert_eq!(
            ProjectScopeService::list_projects(&fixture.db)
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    #[serial_test::serial]
    fn relative_and_missing_paths_are_rejected() {
        let home = tempdir().expect("home");
        let _guard = HomeGuard::set(home.path());
        let db = Arc::new(Database::memory().expect("memory db"));

        assert!(ProjectScopeService::add_project(&db, "relative/path").is_err());
        assert!(ProjectScopeService::add_project(&db, "").is_err());
        let missing = home.path().join("nope");
        assert!(ProjectScopeService::add_project(&db, &missing.to_string_lossy()).is_err());
    }
}
