import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { foldersApi, type FolderScope } from "@/lib/api/folders";
import { skillFoldersApi } from "@/lib/api/skillFolders";

/** Skills 和 MCP 各有各的文件夹，缓存也各存各的 */
export const foldersKey = (scope: FolderScope) => [scope, "folders"] as const;

export function useFolders(scope: FolderScope) {
  return useQuery({
    queryKey: foldersKey(scope),
    queryFn: () => foldersApi.getState(scope),
  });
}

function useFolderMutation<TVars, TResult>(
  scope: FolderScope,
  mutationFn: (vars: TVars) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // 文件夹操作都是改库里的几行，成败之后重读一次就是最新状态
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: foldersKey(scope) }),
  });
}

export function useCreateFolder(scope: FolderScope) {
  return useFolderMutation(scope, (name: string) =>
    foldersApi.create(scope, name),
  );
}

export function useRenameFolder(scope: FolderScope) {
  return useFolderMutation(
    scope,
    ({ id, name }: { id: string; name: string }) =>
      foldersApi.rename(scope, id, name),
  );
}

export function useDeleteFolder(scope: FolderScope) {
  return useFolderMutation(scope, (id: string) => foldersApi.remove(scope, id));
}

export function useMoveToFolder(scope: FolderScope) {
  return useFolderMutation(
    scope,
    ({ itemIds, folderId }: { itemIds: string[]; folderId: string | null }) =>
      foldersApi.moveItems(scope, itemIds, folderId),
  );
}

/** Skills 特有：导出成保留文件夹层级的 ZIP */
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

const collapsedKey = (scope: FolderScope) =>
  // Skills 沿用最早的键名，免得已有的折叠状态丢掉
  scope === "skills"
    ? "cc-switch:skill-folders:collapsed"
    : `cc-switch:${scope}-folders:collapsed`;

/** 哪些文件夹折叠着。只是这台机器上的浏览习惯，记在 localStorage，不进数据库。 */
export function useCollapsedFolders(scope: FolderScope) {
  const storageKey = collapsedKey(scope);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  const persist = React.useCallback(
    (next: Set<string>) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // 存不了就只在本次会话里记着
      }
    },
    [storageKey],
  );

  const toggle = React.useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expand = React.useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return { collapsed, toggle, expand };
}
