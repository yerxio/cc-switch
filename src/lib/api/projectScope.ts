import { invoke } from "@tauri-apps/api/core";

/**
 * 项目级作用域：把受管的 MCP / Skills 投影到**单个仓库内部**。
 *
 * 所有写入都落在项目目录里，不碰任何全局配置：
 * - Claude Code：`<repo>/.mcp.json` + `<repo>/.claude/settings.local.json`（预批准）、`<repo>/.claude/skills/`
 * - Codex CLI：`<repo>/.codex/config.toml` 的 `[mcp_servers.*]`、`<repo>/.agents/skills/`
 *
 * 第一版只支持这两个应用。
 */
export type ProjectScopeApp = "claude" | "codex";

export interface ScopedProject {
  id: string;
  /** 规范化后的绝对路径 */
  path: string;
  name: string;
  addedAt: number;
  /** 目录是否还在（被移走/删掉的项目在界面上标灰） */
  exists: boolean;
}

/** 从会话历史里发现的候选项目（用户不用手填路径） */
export interface ProjectCandidate {
  path: string;
  name: string;
  /** 哪些应用在这个目录里有过会话 */
  apps: string[];
  lastActiveAt?: number | null;
  managed: boolean;
}

/** Codex 只在受信任的项目里加载 `.codex/` 层；这里只读、从不代写 */
export type CodexTrust = "trusted" | "untrusted" | "unknown";

/** 一个格子的三个事实，界面据此渲染四态 */
export interface ProjectCell {
  /** 项目级已绑定（CC Switch 已把它写进这个仓库） */
  bound: boolean;
  /** 全局已启用（继承态；项目级再写一份会覆盖全局那份） */
  global: boolean;
  /** 仓库里已有同名条目而项目级没绑它：点下去会先问要不要强制覆盖 */
  conflict: boolean;
}

export interface ProjectItemState {
  id: string;
  name: string;
  claude: ProjectCell;
  codex: ProjectCell;
}

/**
 * 一次开关的结果。
 *
 * `conflict` 不是错误：目标位置已经有同名的东西，界面弹一次确认，用户点
 * 「强制覆盖」就带 `force: true` 再调一次。
 */
export type ToggleOutcome =
  | { status: "applied" }
  | {
      status: "conflict";
      /** 冲突的键名 / 目录名 */
      key: string;
      /** 冲突落在仓库里的哪个文件或目录（相对路径） */
      path: string;
    };

/** 会写到仓库里的文件/目录，界面上明示「这些会进版本库」 */
export interface ProjectTargets {
  claudeMcp: string;
  claudeApproval: string;
  claudeSkills: string;
  codexMcp: string;
  codexSkills: string;
}

export interface ProjectScopeState {
  project: ScopedProject;
  mcp: ProjectItemState[];
  skills: ProjectItemState[];
  codexTrust: CodexTrust;
  targets: ProjectTargets;
}

export interface ResyncFailure {
  kind: "mcp" | "skill";
  itemId: string;
  app: string;
  error: string;
}

export interface ResyncReport {
  applied: number;
  failures: ResyncFailure[];
}

export const projectScopeApi = {
  /** 受管项目列表 */
  async listProjects(): Promise<ScopedProject[]> {
    return await invoke("list_scoped_projects");
  },

  /** 从 Claude Code / Codex 的会话历史里发现候选项目目录 */
  async discoverCandidates(): Promise<ProjectCandidate[]> {
    return await invoke("discover_scoped_project_candidates");
  },

  /** 加入受管项目（同路径重复加是幂等的） */
  async addProject(path: string): Promise<ScopedProject> {
    return await invoke("add_scoped_project", { path });
  },

  async renameProject(id: string, name: string): Promise<boolean> {
    return await invoke("rename_scoped_project", { id, name });
  },

  /**
   * 移出受管项目。
   *
   * `cleanup` 为真时先把 CC Switch 在该仓库里写过的东西全部撤掉；为假则只删绑定
   * 记录，仓库里已生成的文件原样保留。
   */
  async removeProject(id: string, cleanup: boolean): Promise<ResyncFailure[]> {
    return await invoke("remove_scoped_project", { id, cleanup });
  },

  /** 一个项目的完整状态（每个条目在两个应用下的三态 + Codex 信任 + 外来条目） */
  async getState(projectId: string): Promise<ProjectScopeState> {
    return await invoke("get_project_scope_state", { projectId });
  },

  /** `force` 为真才覆盖同名条目；为假时同名会返回 `status: "conflict"` */
  async toggleMcp(
    projectId: string,
    serverId: string,
    app: ProjectScopeApp,
    enabled: boolean,
    force = false,
  ): Promise<ToggleOutcome> {
    return await invoke("toggle_project_mcp", {
      projectId,
      serverId,
      app,
      enabled,
      force,
    });
  },

  /** 强制覆盖 Skill 会**整个替换**仓库里那个目录 */
  async toggleSkill(
    projectId: string,
    skillId: string,
    app: ProjectScopeApp,
    enabled: boolean,
    force = false,
  ): Promise<ToggleOutcome> {
    return await invoke("toggle_project_skill", {
      projectId,
      skillId,
      app,
      enabled,
      force,
    });
  },

  /** 按库里的绑定全量重投一次（修复手改或误删造成的漂移） */
  async resync(projectId: string): Promise<ResyncReport> {
    return await invoke("resync_project_scope", { projectId });
  },
};
