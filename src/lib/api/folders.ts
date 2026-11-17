import { invoke } from "@tauri-apps/api/core";

/**
 * 文件夹：Skills 与 MCP 共用的收纳视图。
 *
 * 纯粹是面板里的分组——不落盘、不改任何配置文件的内容。只有一层，一个条目最多在
 * 一个文件夹里。两类各有各的文件夹，互不相干（可以重名）。
 */
export type FolderScope = "skills" | "mcp";

export interface Folder {
  id: string;
  name: string;
  sortOrder: number;
}

export interface FoldersState {
  folders: Folder[];
  /** 条目 id → 文件夹 id；不在里面的就是「未分类」 */
  assignments: Record<string, string>;
}

/** 两类用的后端命令不同，移动时条目 id 的参数名也不同 */
const COMMANDS: Record<
  FolderScope,
  {
    get: string;
    create: string;
    rename: string;
    remove: string;
    move: string;
    idsArg: string;
  }
> = {
  skills: {
    get: "get_skill_folders",
    create: "create_skill_folder",
    rename: "rename_skill_folder",
    remove: "delete_skill_folder",
    move: "move_skills_to_folder",
    idsArg: "skillIds",
  },
  mcp: {
    get: "get_mcp_folders",
    create: "create_mcp_folder",
    rename: "rename_mcp_folder",
    remove: "delete_mcp_folder",
    move: "move_mcp_servers_to_folder",
    idsArg: "serverIds",
  },
};

export const foldersApi = {
  async getState(scope: FolderScope): Promise<FoldersState> {
    return await invoke(COMMANDS[scope].get);
  },

  async create(scope: FolderScope, name: string): Promise<Folder> {
    return await invoke(COMMANDS[scope].create, { name });
  },

  async rename(scope: FolderScope, id: string, name: string): Promise<void> {
    await invoke(COMMANDS[scope].rename, { id, name });
  },

  /** 删除文件夹；里面的条目不删，只是回到「未分类」 */
  async remove(scope: FolderScope, id: string): Promise<void> {
    await invoke(COMMANDS[scope].remove, { id });
  },

  /** 把一批条目移进文件夹；`folderId` 为 `null` 则移回「未分类」 */
  async moveItems(
    scope: FolderScope,
    itemIds: string[],
    folderId: string | null,
  ): Promise<number> {
    const { move, idsArg } = COMMANDS[scope];
    return await invoke(move, { [idsArg]: itemIds, folderId });
  },
};
