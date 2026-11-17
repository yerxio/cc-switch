import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  projectScopeApi,
  type ProjectScopeApp,
  type ScopedProject,
} from "@/lib/api/projectScope";

/**
 * 项目级作用域的查询与开关。
 *
 * 作用域选择（全局 / 哪个项目）是**跨面板共享**的：在 MCP 面板里选了某个项目，
 * 切到 Skills 面板应该还停在同一个项目上，所以存在 localStorage 而不是组件状态。
 */

const SELECTED_PROJECT_KEY = "cc-switch:project-scope:selected";

const PROJECT_SCOPE_KEY = ["projectScope"] as const;

export function useScopedProjects() {
  return useQuery({
    queryKey: [...PROJECT_SCOPE_KEY, "projects"],
    queryFn: () => projectScopeApi.listProjects(),
  });
}

export function useProjectScopeState(projectId: string | null) {
  return useQuery({
    queryKey: [...PROJECT_SCOPE_KEY, "state", projectId],
    queryFn: () => projectScopeApi.getState(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useAddScopedProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => projectScopeApi.addProject(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECT_SCOPE_KEY });
    },
  });
}

export function useRemoveScopedProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cleanup }: { id: string; cleanup: boolean }) =>
      projectScopeApi.removeProject(id, cleanup),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECT_SCOPE_KEY });
    },
  });
}

export function useToggleProjectMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      serverId,
      app,
      enabled,
      force,
    }: {
      projectId: string;
      serverId: string;
      app: ProjectScopeApp;
      enabled: boolean;
      /** 真 = 覆盖仓库里的同名条目 */
      force?: boolean;
    }) => projectScopeApi.toggleMcp(projectId, serverId, app, enabled, force),
    // 写文件失败时库里也可能已经改了，成败都要重读状态
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECT_SCOPE_KEY });
    },
  });
}

export function useToggleProjectSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      skillId,
      app,
      enabled,
      force,
    }: {
      projectId: string;
      skillId: string;
      app: ProjectScopeApp;
      enabled: boolean;
      /** 真 = 整个替换仓库里的同名目录 */
      force?: boolean;
    }) => projectScopeApi.toggleSkill(projectId, skillId, app, enabled, force),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECT_SCOPE_KEY });
    },
  });
}

/** 一次文件夹级开关的结果 */
export interface BulkProjectResult {
  applied: string[];
  /** 仓库里已有同名的、没写入的（要覆盖得逐个点开确认） */
  conflicts: string[];
  failed: { id: string; error: string }[];
}

/**
 * 给一批条目在某个项目某个应用下统一绑定 / 解绑（文件夹行上的格子用）。
 *
 * 逐条调用，但中途不碰缓存，全部跑完才刷新一次——单条的那个 mutation 每次都
 * 重读整个项目状态，放进循环里就是每条重画一遍整张表。
 * 同名冲突的不强制覆盖：覆盖是破坏性的，不该夹在批量操作里悄悄做。
 */
export function useBulkToggleProjectItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      projectId,
      itemIds,
      app,
      enabled,
    }: {
      kind: "mcp" | "skill";
      projectId: string;
      itemIds: string[];
      app: ProjectScopeApp;
      enabled: boolean;
    }): Promise<BulkProjectResult> => {
      const toggle =
        kind === "mcp"
          ? projectScopeApi.toggleMcp
          : projectScopeApi.toggleSkill;
      const result: BulkProjectResult = {
        applied: [],
        conflicts: [],
        failed: [],
      };
      for (const id of itemIds) {
        try {
          const outcome = await toggle(projectId, id, app, enabled, false);
          if (outcome.status === "conflict") result.conflicts.push(id);
          else result.applied.push(id);
        } catch (error) {
          result.failed.push({ id, error: String(error) });
        }
      }
      return result;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECT_SCOPE_KEY });
    },
  });
}

export function useResyncProjectScope() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => projectScopeApi.resync(projectId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECT_SCOPE_KEY });
    },
  });
}

/**
 * 当前作用域：`null` = 全局，否则是受管项目的 id。
 *
 * 选中的项目被移出受管列表后要自动退回全局，否则面板会卡在一个查不到的 id 上。
 */
export function useSelectedProjectScope(projects: ScopedProject[] | undefined) {
  const [projectId, setProjectId] = React.useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SELECTED_PROJECT_KEY);
    } catch {
      return null;
    }
  });

  React.useEffect(() => {
    if (!projectId || !projects) return;
    if (!projects.some((project) => project.id === projectId)) {
      setProjectId(null);
    }
  }, [projectId, projects]);

  const select = React.useCallback((next: string | null) => {
    setProjectId(next);
    try {
      if (next) {
        window.localStorage.setItem(SELECTED_PROJECT_KEY, next);
      } else {
        window.localStorage.removeItem(SELECTED_PROJECT_KEY);
      }
    } catch {
      // 隐私模式 / 禁用存储：作用域只是不跨会话记住，不影响功能
    }
  }, []);

  return { projectId, select };
}
