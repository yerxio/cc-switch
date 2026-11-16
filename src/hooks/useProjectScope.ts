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

/** 候选项目来自会话历史，扫描有成本，只在打开选择器时才拉 */
export function useProjectCandidates(enabled: boolean) {
  return useQuery({
    queryKey: [...PROJECT_SCOPE_KEY, "candidates"],
    queryFn: () => projectScopeApi.discoverCandidates(),
    enabled,
    staleTime: 60_000,
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
    }: {
      projectId: string;
      serverId: string;
      app: ProjectScopeApp;
      enabled: boolean;
    }) => projectScopeApi.toggleMcp(projectId, serverId, app, enabled),
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
    }: {
      projectId: string;
      skillId: string;
      app: ProjectScopeApp;
      enabled: boolean;
    }) => projectScopeApi.toggleSkill(projectId, skillId, app, enabled),
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
