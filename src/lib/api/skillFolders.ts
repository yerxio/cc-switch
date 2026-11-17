import { invoke } from "@tauri-apps/api/core";
import type { Folder, FoldersState } from "./folders";

/**
 * Skill 文件夹就是通用文件夹（见 `./folders`）用在 Skills 上；这里只剩 Skills
 * 特有的 ZIP 导出。
 */
export type SkillFolder = Folder;
export type SkillFoldersState = FoldersState;

export interface SkillExportReport {
  path: string;
  exported: number;
  /** 库里有记录、存储目录里却没有文件的 Skill（名字），没法导出 */
  missing: string[];
}

export const skillFoldersApi = {
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
