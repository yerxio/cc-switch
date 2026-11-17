import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { skillFoldersApi } from "@/lib/api/skillFolders";

export const SKILL_FOLDERS_KEY = ["skills", "folders"] as const;

export function useSkillFolders() {
  return useQuery({
    queryKey: SKILL_FOLDERS_KEY,
    queryFn: () => skillFoldersApi.getState(),
  });
}

function useFolderMutation<TVars, TResult>(
  mutationFn: (vars: TVars) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // 文件夹操作都是改库里的几行，成败之后重读一次就是最新状态
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: SKILL_FOLDERS_KEY }),
  });
}

export function useCreateSkillFolder() {
  return useFolderMutation((name: string) => skillFoldersApi.create(name));
}

export function useRenameSkillFolder() {
  return useFolderMutation(({ id, name }: { id: string; name: string }) =>
    skillFoldersApi.rename(id, name),
  );
}

export function useDeleteSkillFolder() {
  return useFolderMutation((id: string) => skillFoldersApi.remove(id));
}

export function useMoveSkillsToFolder() {
  return useFolderMutation(
    ({ skillIds, folderId }: { skillIds: string[]; folderId: string | null }) =>
      skillFoldersApi.moveSkills(skillIds, folderId),
  );
}

export function useExportSkillsZip() {
  return useMutation({
    mutationFn: ({
      skillIds,
      filePath,
    }: {
      skillIds: string[];
      filePath: string;
    }) => skillFoldersApi.exportZip(skillIds, filePath),
  });
}

const COLLAPSED_KEY = "cc-switch:skill-folders:collapsed";

/** 哪些文件夹折叠着。只是这台机器上的浏览习惯，记在 localStorage，不进数据库。 */
export function useCollapsedFolders() {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  const persist = (next: Set<string>) => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // 存不了就只在本次会话里记着
    }
  };

  const toggle = React.useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persist(next);
      return next;
    });
  }, []);

  const expand = React.useCallback((key: string) => {
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      persist(next);
      return next;
    });
  }, []);

  return { collapsed, toggle, expand };
}
