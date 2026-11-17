//! Skill 文件夹：收纳视图，以及带文件夹层级的 ZIP 导出 / 导入
//!
//! ## 文件夹是虚拟的
//!
//! Claude Code、Codex 等只从扁平的 `<skills>/<name>/SKILL.md` 加载 Skill，磁盘上
//! 真嵌一层目录它们就认不出来了。所以文件夹只存在于数据库：影响面板怎么分组、
//! 怎么批量操作，**不改变任何文件的落点**。移动文件夹不触发任何文件操作。
//!
//! 第一版的两个取舍：只有一层（不嵌套），一个 Skill 最多在一个文件夹里。
//!
//! ## ZIP 里的层级约定
//!
//! 导出：`<文件夹>/<skill 目录>/…`，未分类的直接在根目录 `<skill 目录>/…`，
//! 另在根目录放一份清单 [`MANIFEST_NAME`] 记下每个 Skill 归哪个文件夹。
//!
//! 导入：有清单按清单（文件夹名可以含不能当目录名的字符，目录名只是近似）；
//! 没有清单——别处来的 ZIP——按目录层级推断，层级里没有文件夹可用的（直接放在
//! 根目录的）进以压缩包命名的文件夹，见 [`infer_folders`]。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::database::{Database, FolderKind};
use crate::error::AppError;
use crate::services::folders::FolderService;
use crate::services::skill::SkillService;

/// ZIP 根目录里的清单文件名
pub const MANIFEST_NAME: &str = "cc-switch-skills.json";
const MANIFEST_VERSION: u32 = 1;
/// 以压缩包命名的文件夹，名字最多取这么多字符（文件夹名的上限）
const ZIP_FOLDER_NAME_MAX_CHARS: usize = 64;
/// Skill 文件夹就是通用文件夹用在 Skills 上
pub use crate::services::folders::{Folder as SkillFolder, FoldersState as SkillFoldersState};

/// 一次导出的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExportReport {
    pub path: String,
    pub exported: usize,
    /// 库里有记录、存储目录里却没有文件的 Skill（名字），没法导出
    pub missing: Vec<String>,
}

/// ZIP 根目录的清单
#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    /// Skill 目录名 → 文件夹名
    #[serde(default)]
    folders: BTreeMap<String, String>,
}

pub struct SkillFolderService;

impl SkillFolderService {
    // 增删改移都是通用文件夹的事（见 [`FolderService`]），这里只是把种类定成 Skill，
    // 让本模块的导出 / 导入和调用方不用每次带上 `FolderKind::Skill`。

    pub fn state(db: &Arc<Database>) -> Result<SkillFoldersState, AppError> {
        FolderService::state(db, FolderKind::Skill)
    }

    pub fn create(db: &Arc<Database>, raw_name: &str) -> Result<SkillFolder, AppError> {
        FolderService::create(db, FolderKind::Skill, raw_name)
    }

    /// 按名字取文件夹 id，没有就建。导入 ZIP 时用：同名文件夹直接并进去。
    pub fn ensure(db: &Arc<Database>, raw_name: &str) -> Result<String, AppError> {
        FolderService::ensure(db, FolderKind::Skill, raw_name)
    }

    pub fn rename(db: &Arc<Database>, id: &str, raw_name: &str) -> Result<(), AppError> {
        FolderService::rename(db, FolderKind::Skill, id, raw_name)
    }

    /// 删除文件夹。里面的 Skill 不卸载，只是回到「未分类」。
    pub fn delete(db: &Arc<Database>, id: &str) -> Result<(), AppError> {
        FolderService::delete(db, FolderKind::Skill, id)
    }

    /// 把一批 Skill 移进某个文件夹；`folder_id` 为 `None` 则移回「未分类」。
    pub fn move_skills(
        db: &Arc<Database>,
        skill_ids: &[String],
        folder_id: Option<&str>,
    ) -> Result<usize, AppError> {
        FolderService::move_items(db, FolderKind::Skill, skill_ids, folder_id)
    }

    /// 把选中的 Skill 导出成一个 ZIP，保留文件夹层级。
    ///
    /// 库里有记录但存储目录里没有文件的 Skill 导不出来，逐个记进 `missing`，
    /// 不让它们拖垮整次导出。
    pub fn export_zip(
        db: &Arc<Database>,
        skill_ids: &[String],
        dest: &Path,
    ) -> Result<SkillExportReport, AppError> {
        let state = Self::state(db)?;
        let folder_names: HashMap<&str, &str> = state
            .folders
            .iter()
            .map(|folder| (folder.id.as_str(), folder.name.as_str()))
            .collect();
        let skills = db.get_all_installed_skills()?;
        let ssot = SkillService::get_ssot_dir().map_err(|e| AppError::Config(e.to_string()))?;

        // 先定好每个文件夹在 ZIP 里叫什么：目录名不能含路径分隔符等字符，
        // 也不能和根目录里未分类 Skill 的目录撞名（否则会变成 Skill 套 Skill）
        let wanted: BTreeSet<&String> = skill_ids.iter().collect();
        let mut taken: BTreeSet<String> = skills
            .values()
            .filter(|skill| {
                wanted.contains(&skill.id) && !state.assignments.contains_key(&skill.id)
            })
            .map(|skill| skill.directory.to_lowercase())
            .collect();
        let mut zip_dirs: HashMap<&str, String> = HashMap::new();
        for folder in &state.folders {
            let base = zip_safe_dir_name(&folder.name);
            let mut candidate = base.clone();
            let mut suffix = 2;
            while !taken.insert(candidate.to_lowercase()) {
                candidate = format!("{base}-{suffix}");
                suffix += 1;
            }
            zip_dirs.insert(folder.id.as_str(), candidate);
        }

        let file = fs::File::create(dest).map_err(|e| AppError::io(dest, e))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        let mut manifest = Manifest {
            version: MANIFEST_VERSION,
            folders: BTreeMap::new(),
        };
        let mut exported = 0usize;
        let mut missing = Vec::new();

        for skill_id in skill_ids {
            let Some(skill) = skills.get(skill_id) else {
                continue;
            };
            let source = ssot.join(&skill.directory);
            if !source.join("SKILL.md").is_file() {
                missing.push(skill.name.clone());
                continue;
            }
            let folder_id = state.assignments.get(skill_id).map(String::as_str);
            let prefix = match folder_id.and_then(|id| zip_dirs.get(id)) {
                Some(zip_dir) => format!("{zip_dir}/{}", skill.directory),
                None => skill.directory.clone(),
            };
            if let Some(name) = folder_id.and_then(|id| folder_names.get(id)) {
                manifest
                    .folders
                    .insert(skill.directory.clone(), (*name).to_string());
            }
            add_dir_to_zip(&mut zip, &source, &prefix, options)?;
            exported += 1;
        }

        let manifest_text = serde_json::to_string_pretty(&manifest)
            .map_err(|source| AppError::JsonSerialize { source })?;
        zip.start_file(MANIFEST_NAME, options)
            .map_err(|e| AppError::Config(format!("写入清单失败: {e}")))?;
        zip.write_all(manifest_text.as_bytes())
            .map_err(|e| AppError::io(dest, e))?;
        zip.finish()
            .map_err(|e| AppError::Config(format!("写入 ZIP 失败: {e}")))?;

        log::info!(
            "Skill 导出：{} 个写入 {}，{} 个缺文件",
            exported,
            dest.display(),
            missing.len()
        );
        Ok(SkillExportReport {
            path: dest.display().to_string(),
            exported,
            missing,
        })
    }
}

/// 把文件夹名变成能当 ZIP 目录名的东西。确切的名字记在清单里，这里只求能用。
fn zip_safe_dir_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "folder".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 递归把一个目录写进 ZIP 的 `prefix/` 下。符号链接不跟：导出的是 Skill 的内容，
/// 不该顺着链接把目录外的东西打包走。
fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| AppError::io(dir, e))?
        .flatten()
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        if file_type.is_dir() {
            add_dir_to_zip(zip, &path, &name, options)?;
        } else {
            zip.start_file(name.as_str(), options)
                .map_err(|e| AppError::Config(format!("写入 {name} 失败: {e}")))?;
            let bytes = fs::read(&path).map_err(|e| AppError::io(&path, e))?;
            zip.write_all(&bytes).map_err(|e| AppError::io(&path, e))?;
        }
    }
    Ok(())
}

/// 给解压出来的每个 Skill 目录定一个文件夹名（定不出来的不在返回值里）。
///
/// 1. 根目录有清单 → 按清单（键是 Skill 的目录名）。清单是权威的：它没提到的
///    Skill 在导出时就是未分类，这里原样留在未分类，导出再导入才能还原。
/// 2. 否则按层级推断：Skill 的**直接上级目录**就是它的文件夹。两个例外——
///    - 所有 Skill 都挤在同一个顶层目录下（GitHub 打的包常见的 `repo-main/…`）：
///      那一层是包装，不算文件夹，剥掉再看；
///    - Skill 直接在根目录（或剥掉包装后在根目录）：层级里没有文件夹可用，
///      放进 `fallback`——以压缩包命名的文件夹。一个 ZIP 就是一批东西，散进
///      「未分类」的话和原来就在那儿的混在一起，事后分不出哪些是这次导入的。
///      `fallback` 为 `None` 时才留在未分类。
pub fn infer_folders(
    root: &Path,
    skill_dirs: &[PathBuf],
    fallback: Option<&str>,
) -> HashMap<PathBuf, String> {
    let mut out = HashMap::new();

    if let Some(manifest) = read_manifest(root) {
        for dir in skill_dirs {
            let Some(name) = dir
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
            else {
                continue;
            };
            if let Some(folder) = manifest.folders.get(&name) {
                out.insert(dir.clone(), folder.clone());
            }
        }
        return out;
    }

    let relative: Vec<(&PathBuf, Vec<String>)> = skill_dirs
        .iter()
        .filter_map(|dir| {
            let rest = dir.strip_prefix(root).ok()?;
            let parts: Vec<String> = rest
                .components()
                .map(|part| part.as_os_str().to_string_lossy().to_string())
                .collect();
            Some((dir, parts))
        })
        .collect();

    // 包装层：每个 Skill 的路径都至少两段，且第一段全都一样
    let wrapper = relative
        .first()
        .and_then(|(_, parts)| parts.first().cloned())
        .filter(|first| {
            relative
                .iter()
                .all(|(_, parts)| parts.len() >= 2 && parts.first() == Some(first))
        });
    let skip = usize::from(wrapper.is_some());

    for (dir, parts) in relative {
        let parts = &parts[skip.min(parts.len())..];
        let parent = (parts.len() >= 2)
            .then(|| &parts[parts.len() - 2])
            .filter(|parent| !parent.starts_with('.') && parent.as_str() != "__MACOSX");
        match (parent, fallback) {
            (Some(parent), _) => {
                out.insert(dir.clone(), parent.clone());
            }
            (None, Some(fallback)) => {
                out.insert(dir.clone(), fallback.to_string());
            }
            (None, None) => {}
        }
    }
    out
}

/// 把压缩包文件名变成可用的文件夹名：去掉首尾空白，超长就截断。
/// 截出来是空的（文件名全是空白之类）就没有可用的名字。
pub fn folder_name_from_zip_stem(stem: &str) -> Option<String> {
    let name: String = stem
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(ZIP_FOLDER_NAME_MAX_CHARS)
        .collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn read_manifest(root: &Path) -> Option<Manifest> {
    let text = fs::read_to_string(root.join(MANIFEST_NAME)).ok()?;
    let manifest: Manifest = serde_json::from_str(&text).ok()?;
    // 版本更高的清单可能换了结构，宁可退回按层级推断
    (manifest.version <= MANIFEST_VERSION).then_some(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::{InstalledSkill, SkillApps};
    use std::ffi::OsString;
    use tempfile::{tempdir, TempDir};

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

    fn setup() -> (TempDir, HomeGuard, Arc<Database>) {
        let home = tempdir().expect("home");
        let guard = HomeGuard::set(home.path());
        let db = Arc::new(Database::memory().expect("memory db"));
        (home, guard, db)
    }

    /// 在存储目录里造一个 Skill 并入库
    fn seed_skill(db: &Arc<Database>, directory: &str) -> String {
        let dir = SkillService::get_ssot_dir().expect("ssot").join(directory);
        fs::create_dir_all(dir.join("scripts")).expect("mkdir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {directory}\ndescription: test\n---\n"),
        )
        .expect("write SKILL.md");
        fs::write(dir.join("scripts").join("run.sh"), "echo hi\n").expect("write script");

        let id = format!("local:{directory}");
        db.save_skill(&InstalledSkill {
            id: id.clone(),
            name: directory.to_string(),
            description: None,
            directory: directory.to_string(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps: SkillApps::default(),
            installed_at: 0,
            content_hash: None,
            updated_at: 0,
        })
        .expect("save skill");
        id
    }

    #[test]
    #[serial_test::serial]
    fn a_skill_lives_in_at_most_one_folder_and_moving_it_is_bookkeeping_only() {
        let (_home, _guard, db) = setup();
        let alpha = seed_skill(&db, "alpha");
        let beta = seed_skill(&db, "beta");
        let ssot = SkillService::get_ssot_dir().expect("ssot");

        let reversing = SkillFolderService::create(&db, "  逆向分析  ").expect("create");
        assert_eq!(reversing.name, "逆向分析", "名字两端的空白要去掉");
        let web = SkillFolderService::create(&db, "Web").expect("create");

        SkillFolderService::move_skills(&db, &[alpha.clone(), beta.clone()], Some(&reversing.id))
            .expect("move in");
        // 再移到另一个文件夹：是换，不是又多一份
        SkillFolderService::move_skills(&db, std::slice::from_ref(&alpha), Some(&web.id))
            .expect("move over");

        let state = SkillFolderService::state(&db).expect("state");
        assert_eq!(state.assignments.get(&alpha), Some(&web.id));
        assert_eq!(state.assignments.get(&beta), Some(&reversing.id));
        assert_eq!(state.assignments.len(), 2);

        // 文件夹是虚拟的：存储目录里没有任何以文件夹命名的东西，Skill 还在原地
        assert!(ssot.join("alpha").join("SKILL.md").is_file());
        assert!(!ssot.join("Web").exists());
        assert!(!ssot.join("逆向分析").exists());

        // 移回未分类
        SkillFolderService::move_skills(&db, std::slice::from_ref(&alpha), None).expect("move out");
        assert!(!SkillFolderService::state(&db)
            .expect("state")
            .assignments
            .contains_key(&alpha));
    }

    #[test]
    #[serial_test::serial]
    fn folder_names_are_unique_ignoring_case_and_validated() {
        let (_home, _guard, db) = setup();
        let web = SkillFolderService::create(&db, "Web").expect("create");

        assert!(
            SkillFolderService::create(&db, "web").is_err(),
            "大小写不同也算重名"
        );
        assert!(SkillFolderService::create(&db, "   ").is_err());
        assert!(SkillFolderService::create(&db, &"长".repeat(65)).is_err());

        let other = SkillFolderService::create(&db, "Other").expect("create");
        assert!(
            SkillFolderService::rename(&db, &other.id, "WEB").is_err(),
            "改名不能撞上别的文件夹"
        );
        // 只改自己名字的大小写是允许的
        SkillFolderService::rename(&db, &web.id, "WEB").expect("recase own name");
    }

    #[test]
    #[serial_test::serial]
    fn deleting_a_folder_keeps_its_skills_installed() {
        let (_home, _guard, db) = setup();
        let alpha = seed_skill(&db, "alpha");
        let folder = SkillFolderService::create(&db, "Tools").expect("create");
        SkillFolderService::move_skills(&db, std::slice::from_ref(&alpha), Some(&folder.id))
            .expect("move");

        SkillFolderService::delete(&db, &folder.id).expect("delete");

        let state = SkillFolderService::state(&db).expect("state");
        assert!(state.folders.is_empty());
        assert!(state.assignments.is_empty(), "Skill 回到未分类");
        assert!(
            db.get_installed_skill(&alpha).expect("lookup").is_some(),
            "删文件夹不卸载里面的 Skill"
        );
    }

    #[test]
    #[serial_test::serial]
    fn uninstalling_a_skill_drops_its_folder_membership() {
        let (_home, _guard, db) = setup();
        let alpha = seed_skill(&db, "alpha");
        let folder = SkillFolderService::create(&db, "Tools").expect("create");
        SkillFolderService::move_skills(&db, std::slice::from_ref(&alpha), Some(&folder.id))
            .expect("move");

        SkillService::uninstall(&db, &alpha).expect("uninstall");

        let state = SkillFolderService::state(&db).expect("state");
        assert!(
            state.assignments.is_empty(),
            "已卸载的 Skill 不该还挂在文件夹里"
        );
        assert_eq!(state.folders.len(), 1, "文件夹本身留着");
    }

    /// 导出再导入要原样还原：文件夹名（哪怕含不能当目录名的字符）、谁在哪个
    /// 文件夹、谁没分类，以及 Skill 目录里的嵌套文件。
    #[test]
    #[serial_test::serial]
    fn export_then_import_restores_folders_and_contents() {
        let (home, _guard, db) = setup();
        let alpha = seed_skill(&db, "alpha");
        let beta = seed_skill(&db, "beta");
        let loose = seed_skill(&db, "loose");

        // 带斜杠和冒号的名字当不了目录名，得靠清单还原
        let tricky = SkillFolderService::create(&db, "逆向/分析: 工具").expect("create");
        let web = SkillFolderService::create(&db, "Web").expect("create");
        SkillFolderService::move_skills(&db, std::slice::from_ref(&alpha), Some(&tricky.id))
            .expect("move");
        SkillFolderService::move_skills(&db, std::slice::from_ref(&beta), Some(&web.id))
            .expect("move");

        let zip_path = home.path().join("export.zip");
        let report = SkillFolderService::export_zip(
            &db,
            &[alpha.clone(), beta.clone(), loose.clone()],
            &zip_path,
        )
        .expect("export");
        assert_eq!(report.exported, 3);
        assert!(report.missing.is_empty());

        // 清空，模拟拿到另一台机器上
        for id in [&alpha, &beta, &loose] {
            SkillService::uninstall(&db, id).expect("uninstall");
        }
        SkillFolderService::delete(&db, &tricky.id).expect("delete");
        SkillFolderService::delete(&db, &web.id).expect("delete");

        let result = SkillService::install_from_zip(&db, &zip_path, None).expect("import");
        assert_eq!(result.installed.len(), 3);
        let mut used = result.folders.clone();
        used.sort();
        assert_eq!(used, ["Web", "逆向/分析: 工具"]);

        let state = SkillFolderService::state(&db).expect("state");
        let name_of = |skill_id: &str| {
            state.assignments.get(skill_id).and_then(|folder_id| {
                state
                    .folders
                    .iter()
                    .find(|folder| &folder.id == folder_id)
                    .map(|folder| folder.name.clone())
            })
        };
        assert_eq!(name_of("local:alpha").as_deref(), Some("逆向/分析: 工具"));
        assert_eq!(name_of("local:beta").as_deref(), Some("Web"));
        assert_eq!(
            name_of("local:loose"),
            None,
            "有清单时清单说了算：导出时没分类的不该被塞进以压缩包命名的文件夹"
        );
        assert!(
            !state.folders.iter().any(|folder| folder.name == "export"),
            "带清单的 ZIP 不该凭文件名多建一个文件夹"
        );

        // 嵌套文件跟着走了，且存储目录仍是扁平的
        let ssot = SkillService::get_ssot_dir().expect("ssot");
        assert!(ssot.join("alpha").join("scripts").join("run.sh").is_file());
        assert!(ssot.join("loose").join("SKILL.md").is_file());
        assert!(!ssot.join("Web").exists(), "文件夹不该变成磁盘目录");
    }

    /// 没有清单的 ZIP：根目录的 Skill 进以压缩包命名的文件夹，带分类目录的照旧
    #[test]
    #[serial_test::serial]
    fn root_level_skills_from_a_plain_zip_land_in_a_folder_named_after_it() {
        use zip::write::SimpleFileOptions;

        let (home, _guard, db) = setup();
        let zip_path = home.path().join("  安全工具合集  .zip");
        {
            let file = fs::File::create(&zip_path).expect("create zip");
            let mut zip = zip::ZipWriter::new(file);
            let options = SimpleFileOptions::default();
            for entry in ["solo/SKILL.md", "other/SKILL.md", "Web/xss/SKILL.md"] {
                zip.start_file(entry, options).expect("start file");
                let name = entry.rsplit('/').nth(1).expect("skill dir");
                zip.write_all(format!("---\nname: {name}\ndescription: t\n---\n").as_bytes())
                    .expect("write");
            }
            zip.finish().expect("finish zip");
        }

        let result = SkillService::install_from_zip(&db, &zip_path, None).expect("import");
        assert_eq!(result.installed.len(), 3);

        let state = SkillFolderService::state(&db).expect("state");
        let name_of = |skill_id: &str| {
            state.assignments.get(skill_id).and_then(|folder_id| {
                state
                    .folders
                    .iter()
                    .find(|folder| &folder.id == folder_id)
                    .map(|folder| folder.name.clone())
            })
        };
        // 文件名两端的空白去掉了
        assert_eq!(name_of("local:solo").as_deref(), Some("安全工具合集"));
        assert_eq!(name_of("local:other").as_deref(), Some("安全工具合集"));
        assert_eq!(name_of("local:xss").as_deref(), Some("Web"));
        assert_eq!(state.assignments.len(), 3, "这次导入的没有一个落进未分类");

        // 再导一个同名压缩包里的新 Skill：并进已有的同名文件夹，不重复建
        let again = home.path().join("more").join("安全工具合集.zip");
        fs::create_dir_all(again.parent().expect("parent")).expect("mkdir");
        {
            let file = fs::File::create(&again).expect("create zip");
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("third/SKILL.md", SimpleFileOptions::default())
                .expect("start file");
            zip.write_all(b"---\nname: third\ndescription: t\n---\n")
                .expect("write");
            zip.finish().expect("finish zip");
        }
        SkillService::install_from_zip(&db, &again, None).expect("import again");
        let state = SkillFolderService::state(&db).expect("state");
        assert_eq!(
            state
                .folders
                .iter()
                .filter(|folder| folder.name == "安全工具合集")
                .count(),
            1
        );
    }

    #[test]
    fn a_zip_file_name_becomes_a_usable_folder_name() {
        assert_eq!(
            folder_name_from_zip_stem("  my pack  ").as_deref(),
            Some("my pack")
        );
        assert_eq!(folder_name_from_zip_stem("   "), None);
        // 超过文件夹名上限的截断，而不是让整次归类失败
        let long = "长".repeat(100);
        assert_eq!(
            folder_name_from_zip_stem(&long).map(|name| name.chars().count()),
            Some(64)
        );
    }

    #[test]
    #[serial_test::serial]
    fn export_reports_skills_whose_files_are_gone_instead_of_failing() {
        let (home, _guard, db) = setup();
        let alpha = seed_skill(&db, "alpha");
        let ghost = seed_skill(&db, "ghost");
        fs::remove_dir_all(SkillService::get_ssot_dir().expect("ssot").join("ghost"))
            .expect("remove ghost files");

        let report =
            SkillFolderService::export_zip(&db, &[alpha, ghost], &home.path().join("out.zip"))
                .expect("export");
        assert_eq!(report.exported, 1);
        assert_eq!(report.missing, ["ghost"]);
    }

    /// 没有清单的 ZIP（别处来的）按层级推断
    #[test]
    fn folders_are_inferred_from_layout_when_there_is_no_manifest() {
        let root = tempdir().expect("root");
        let mk = |relative: &str| {
            let dir = root.path().join(relative);
            fs::create_dir_all(&dir).expect("mkdir");
            fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").expect("write");
            dir
        };

        // 深一层的，直接上级就是文件夹；根目录的没有层级可用，进以压缩包命名的那个
        let at_root = mk("solo");
        let in_web = mk("Web/xss");
        let in_rev = mk("逆向/ida");
        let dirs = [at_root.clone(), in_web.clone(), in_rev.clone()];
        let hints = infer_folders(root.path(), &dirs, Some("my-pack"));
        assert_eq!(hints.get(&at_root).map(String::as_str), Some("my-pack"));
        assert_eq!(hints.get(&in_web).map(String::as_str), Some("Web"));
        assert_eq!(hints.get(&in_rev).map(String::as_str), Some("逆向"));

        // 没有可用的压缩包名时，根目录的才留在未分类
        let hints = infer_folders(root.path(), &dirs, None);
        assert_eq!(hints.get(&at_root), None);
        assert_eq!(hints.get(&in_web).map(String::as_str), Some("Web"));
    }

    /// GitHub 打的包外面常套一层 `repo-main/`：所有 Skill 共用的那一层是包装，不算文件夹
    #[test]
    fn a_single_wrapping_directory_is_not_mistaken_for_a_folder() {
        let root = tempdir().expect("root");
        let mk = |relative: &str| {
            let dir = root.path().join(relative);
            fs::create_dir_all(&dir).expect("mkdir");
            fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").expect("write");
            dir
        };

        let flat_a = mk("repo-main/a");
        let flat_b = mk("repo-main/b");
        let flat = [flat_a.clone(), flat_b.clone()];
        // 包装层不是文件夹：剥掉后它们等于在根目录，进以压缩包命名的文件夹，
        // 而不是进一个叫 repo-main 的文件夹
        let hints = infer_folders(root.path(), &flat, Some("my-pack"));
        assert_eq!(hints.get(&flat_a).map(String::as_str), Some("my-pack"));
        assert_eq!(hints.get(&flat_b).map(String::as_str), Some("my-pack"));
        assert!(
            infer_folders(root.path(), &flat, None).is_empty(),
            "没有压缩包名可用时，只有包装层就谁都不进文件夹"
        );

        // 包装层里面还有真正的分类
        let nested = mk("repo-main/Web/xss");
        let hints = infer_folders(
            root.path(),
            &[flat_a.clone(), nested.clone()],
            Some("my-pack"),
        );
        assert_eq!(hints.get(&flat_a).map(String::as_str), Some("my-pack"));
        assert_eq!(hints.get(&nested).map(String::as_str), Some("Web"));
    }
}
