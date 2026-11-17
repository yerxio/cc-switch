import { invoke } from "@tauri-apps/api/core";

/**
 * Skill 文件夹：纯收纳视图。
 *
 * 各工具只认扁平的 `<skills>/<name>/SKILL.md`，所以文件夹不落盘，只影响面板怎么
 * 分组和批量操作。只有一层，一个 Skill 最多在一个文件夹里。
 */
export interface SkillFolder {
  id: string;
  name: string;
  sortOrder: number;
}

export interface SkillFoldersState {
  folders: SkillFolder[];
  /** Skill id → 文件夹 id；不在里面的就是「未分类」 */
  assignments: Record<string, string>;
}

export interface SkillExportReport {
  path: string;
  exported: number;
  /** 库里有记录、存储目录里却没有文件的 Skill（名字），没法导出 */
  missing: string[];
}

export const skillFoldersApi = {
  async getState(): Promise<SkillFoldersState> {
    return await invoke("get_skill_folders");
  },

  async create(name: string): Promise<SkillFolder> {
    return await invoke("create_skill_folder", { name });
  },

  async rename(id: string, name: string): Promise<void> {
    await invoke("rename_skill_folder", { id, name });
  },

  /** 删除文件夹；里面的 Skill 不卸载，只是回到「未分类」 */
  async remove(id: string): Promise<void> {
    await invoke("delete_skill_folder", { id });
  },

  /** 把一批 Skill 移进文件夹；`folderId` 为 `null` 则移回「未分类」 */
  async moveSkills(
    skillIds: string[],
    folderId: string | null,
  ): Promise<number> {
    return await invoke("move_skills_to_folder", { skillIds, folderId });
  },

  /** 选一个保存 ZIP 的位置；取消返回 `null` */
  async pickExportPath(defaultName: string): Promise<string | null> {
    return await invoke("save_skills_zip_dialog", { defaultName });
  },

  /** 导出成 ZIP，保留文件夹层级（再导入能原样还原） */
  async exportZip(
    skillIds: string[],
    filePath: string,
  ): Promise<SkillExportReport> {
    return await invoke("export_skills_zip", { skillIds, filePath });
  },
};
