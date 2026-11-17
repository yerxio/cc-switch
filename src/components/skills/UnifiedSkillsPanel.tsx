import { createPortal } from "react-dom";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useTranslation } from "react-i18next";
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { Notice, NoticeSlot } from "@/components/ui/notice";
import { PageTabs } from "@/components/ui/page-tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/hover-tip";
import { Checkbox } from "@/components/ui/checkbox";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { SkillsIcon } from "@/components/BrandIcons";
import {
  type ImportSkillSelection,
  type InstalledSkill,
  type SkillBackupEntry,
  type SkillUpdateInfo,
  useBulkToggleSkillApp,
  useCheckSkillUpdates,
  useDeleteSkillBackup,
  useDiscoverableSkills,
  useDiscoverableSkillsFailures,
  useImportSkillsFromApps,
  useInstallSkillsFromZip,
  useInstalledSkills,
  useRefreshLocalSkillMetadata,
  useRestoreSkillBackup,
  useScanUnmanagedSkills,
  useSkillBackups,
  useSkillRepos,
  useToggleSkillApp,
  useUninstallSkills,
  useUninstallSkill,
  useUpdateSkill,
} from "@/hooks/useSkills";
import type { AppId } from "@/lib/api/types";
import { settingsApi, skillsApi } from "@/lib/api";
import type { SkillUninstallResult } from "@/lib/api/skills";
import { skillFoldersApi, type SkillFolder } from "@/lib/api/skillFolders";
import {
  useCollapsedFolders,
  useCreateSkillFolder,
  useDeleteSkillFolder,
  useExportSkillsZip,
  useMoveSkillsToFolder,
  useRenameSkillFolder,
  useSkillFolders,
} from "@/hooks/useSkillFolders";
import {
  buildSkillDisplayRows,
  FOLDER_ROW_HEIGHT,
  FolderHeaderRow,
  FolderNameDialog,
  MoveToFolderMenu,
  UNFILED_KEY,
} from "./skillFolders";
import { copyText } from "@/lib/clipboard";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import {
  MatrixCell,
  MatrixColumnHeader,
  MatrixColumnHighlight,
  MatrixSearch,
  NeutralBadge,
  ompDiscoveryColumnNote,
  resolveBulkScope,
  showUndoToast,
} from "@/components/mcp/AppMatrix";
import { V7ConfirmDialog } from "@/components/mcp/formBits";
import { useVisibleAppIds } from "@/components/mcp/useVisibleAppIds";
import { SkillsPage, useSkillRepoActions } from "./SkillsPage";
import { RepoManagerPanel } from "./RepoManagerPanel";
import { SkillImportDialog } from "./SkillImportDialog";
import { SkillRestoreDialog } from "./SkillRestoreDialog";
import { SkillsStorageSheet } from "./SkillsStorageSheet";
import { useSkillsResync } from "./useSkillsResync";
import { useSkillInstallTargets } from "./useSkillInstallTargets";
import { describeRepoFailures } from "./repoFailures";
import { APP_IDS_WITH } from "@/config/appSpecs";
import { ProjectScopeSelector } from "@/components/projectScope/ProjectScopeSelector";
import { ProjectScopeMatrix } from "@/components/projectScope/ProjectScopeMatrix";
import {
  useScopedProjects,
  useSelectedProjectScope,
} from "@/hooks/useProjectScope";

const BACKUP_DIR = "~/.cc-switch/skill-backups";
const EMPTY_FOLDERS: SkillFolder[] = [];
const EMPTY_ASSIGNMENTS: Record<string, string> = {};
/** 已安装列表的行高（InstalledRow 的 h-14）与表头高（h-11），虚拟化按这两个数算 */
const INSTALLED_ROW_HEIGHT = 56;
const MATRIX_HEADER_HEIGHT = 44;

// 表格最小宽度 = 勾选框 + 名称栏保底 + 每个应用一列（MatrixCell 的 w-9）+ 行尾「⋯」（w-10）+ 左右内边距
const NAME_MIN_WIDTH = 240;
const APP_COLUMN_WIDTH = 36;
const matrixMinWidth = (appCount: number) =>
  8 + 24 + 8 + NAME_MIN_WIDTH + appCount * APP_COLUMN_WIDTH + 40 + 8;

type SkillsView = "installed" | "discover";
type StatusFilter = "all" | "updates" | "none" | `app:${AppId}`;

interface WriteFailure {
  desired: boolean;
  error: string;
}
const failKey = (id: string, app: AppId) => `${id}\u0000${app}`;

type ConfirmState =
  | { kind: "uninstall"; ids: string[] }
  | { kind: "updateAll" }
  | { kind: "deleteBackup"; backup: SkillBackupEntry };

interface UnifiedSkillsPanelProps {
  /** 从旧的 skillsDiscovery 视图进来时直接打开「发现」段 */
  initialView?: SkillsView;
  onInteractionBlockedChange?: (blocked: boolean) => void;
  onNavigationBlockedChange?: (blocked: boolean) => void;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return (
      target.type !== "checkbox" &&
      target.type !== "radio" &&
      target.value !== ""
    );
  }
  return false;
}

/**
 * Skills 全局页（v7）：「已安装」矩阵 +「发现」合成一页。
 * Pi 列常驻（应用页里隐藏 Pi 时才不显示）；Pi 的状态来自后端对 ~/.pi/agent/skills 的目录检查，
 * get_installed_skills 返回前会用这个检查结果覆盖 apps.pi，所以这里显示的不是数据库里的开关。
 */
const UnifiedSkillsPanel: React.FC<UnifiedSkillsPanelProps> = ({
  initialView = "installed",
  onInteractionBlockedChange,
  onNavigationBlockedChange,
}) => {
  const { t, i18n } = useTranslation();
  const appIds = useVisibleAppIds(APP_IDS_WITH.skills);
  const { targets, setTargets, installTo } = useSkillInstallTargets(appIds);

  const [view, setView] = useState<SkillsView>(initialView);
  // 「发现」段第一次打开后就一直挂着（隐藏而不卸载），来回切不再重新加载仓库列表
  const [discoverMounted, setDiscoverMounted] = useState(
    initialView === "discover",
  );
  useEffect(() => {
    if (view === "discover") setDiscoverMounted(true);
  }, [view]);
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fails, setFails] = useState<Record<string, WriteFailure>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [repoManagerOpen, setRepoManagerOpen] = useState(false);
  const [dismissedUnmanaged, setDismissedUnmanaged] = useState<number | null>(
    null,
  );
  /** 关掉的是哪一次检查的「仓库没读到」横幅（按检查时间记） */
  const [dismissedRepoFailAt, setDismissedRepoFailAt] = useState<number | null>(
    null,
  );
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [writePending, setWritePending] = useState(false);
  const [isUpdatingMany, setIsUpdatingMany] = useState(false);
  // 更新进度：确认框点完就关，进度显示在搜索框旁的按钮上
  const [updateProgress, setUpdateProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const writeLockRef = useRef(false);
  const checkUpdatesLockRef = useRef(false);

  const {
    data: skills,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = useInstalledSkills();
  // 列表先用数据库快照渲染；本地元数据在后台线程刷新，有新结果时才刷新列表。
  // 独立 query 让开关/安装引起的列表失效不再重复扫描 SSOT 目录（issue #7848）。
  useRefreshLocalSkillMetadata();
  const {
    data: skillBackups = [],
    refetch: refetchSkillBackups,
    isFetching: isFetchingSkillBackups,
  } = useSkillBackups();
  const deleteBackupMutation = useDeleteSkillBackup();
  const toggleAppMutation = useToggleSkillApp();
  const bulkToggleAppMutation = useBulkToggleSkillApp();
  const uninstallMutation = useUninstallSkill();
  const uninstallManyMutation = useUninstallSkills();

  // 文件夹：纯收纳视图，不改变任何文件的落点
  const { data: folderState } = useSkillFolders();
  const folders = folderState?.folders ?? EMPTY_FOLDERS;
  const folderAssignments = folderState?.assignments ?? EMPTY_ASSIGNMENTS;
  const {
    collapsed: collapsedFolders,
    toggle: toggleFolder,
    expand: expandFolder,
  } = useCollapsedFolders();
  const createFolderMutation = useCreateSkillFolder();
  const renameFolderMutation = useRenameSkillFolder();
  const deleteFolderMutation = useDeleteSkillFolder();
  const moveToFolderMutation = useMoveSkillsToFolder();
  const exportZipMutation = useExportSkillsZip();
  /** 取名框：新建（可带上要一并移进去的 Skill）或重命名 */
  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; moveIds: string[] }
    | { mode: "rename"; folder: SkillFolder }
    | null
  >(null);
  const [folderToDelete, setFolderToDelete] = useState<SkillFolder | null>(
    null,
  );
  const restoreBackupMutation = useRestoreSkillBackup();
  // 进入页面时静默扫描一次「本机已有但未管理」的 Skill
  const { data: unmanagedSkills, refetch: scanUnmanaged } =
    useScanUnmanagedSkills({ enabled: true });
  const importMutation = useImportSkillsFromApps();
  const installFromZipMutation = useInstallSkillsFromZip();
  const {
    data: updateCheck,
    refetch: checkUpdates,
    isFetching: isCheckingUpdates,
    dataUpdatedAt: updatesCheckedAt,
  } = useCheckSkillUpdates();
  const skillUpdates = updateCheck?.updates;
  const updateRepoFailures = updateCheck?.failures ?? [];
  const updateSkillMutation = useUpdateSkill();
  const { resync: resyncToApps, isPending: resyncPending } = useSkillsResync();

  const mutationPending =
    deleteBackupMutation.isPending ||
    toggleAppMutation.isPending ||
    bulkToggleAppMutation.isPending ||
    uninstallMutation.isPending ||
    uninstallManyMutation.isPending ||
    restoreBackupMutation.isPending ||
    importMutation.isPending ||
    installFromZipMutation.isPending ||
    updateSkillMutation.isPending ||
    isUpdatingMany;
  const dialogOpen =
    importOpen || restoreOpen || confirm !== null || repoManagerOpen;
  const navigationBlocked = writePending || mutationPending || dialogOpen;
  const interactionBlocked = navigationBlocked || isCheckingUpdates;
  // 外观上的禁用晚 300ms 才出现：点一个格子写得很快时不让整页按钮闪一下变灰。
  // 写入本身仍由写锁（writeLockRef / interactionBlocked）拦着。
  const controlsDisabled = useDelayedFlag(interactionBlocked);

  // 项目级作用域：选中某个项目后，这张矩阵从 12 个工具收窄为 Claude Code / Codex
  // 两列，Skill 的副本也从全局 skills 目录换成那个仓库里的 .claude/skills 与
  // .agents/skills。
  const { data: scopedProjects } = useScopedProjects();
  const { projectId: scopeProjectId, select: selectScope } =
    useSelectedProjectScope(scopedProjects);

  useEffect(() => {
    onInteractionBlockedChange?.(interactionBlocked);
  }, [interactionBlocked, onInteractionBlockedChange]);

  useEffect(() => {
    onNavigationBlockedChange?.(navigationBlocked);
  }, [navigationBlocked, onNavigationBlockedChange]);

  useEffect(
    () => () => {
      onInteractionBlockedChange?.(false);
      onNavigationBlockedChange?.(false);
    },
    [onInteractionBlockedChange, onNavigationBlockedChange],
  );

  const beginWrite = (allowOpenDialog = false) => {
    if (
      checkUpdatesLockRef.current ||
      isCheckingUpdates ||
      writeLockRef.current ||
      mutationPending ||
      (!allowOpenDialog && dialogOpen)
    ) {
      return false;
    }
    writeLockRef.current = true;
    setWritePending(true);
    return true;
  };

  const endWrite = () => {
    writeLockRef.current = false;
    setWritePending(false);
  };

  const listSeparator = t("mcpPage.listSeparator");
  const names = (apps: AppId[]) =>
    apps.map((app) => APP_DISPLAY_NAME[app]).join(listSeparator);
  const noun = t("skillsPage.noun");
  const installedSkills = skills ?? [];

  // ─── 更新 ───────────────────────────────────────────────────────────
  const applicableSkillUpdates = useMemo(() => {
    const installedIds = new Set(installedSkills.map((skill) => skill.id));
    return (skillUpdates ?? []).filter((update) => installedIds.has(update.id));
  }, [skillUpdates, installedSkills]);

  const updatesMap = useMemo(() => {
    const map: Record<string, SkillUpdateInfo> = {};
    for (const update of applicableSkillUpdates) map[update.id] = update;
    return map;
  }, [applicableSkillUpdates]);

  const lastCheckedText = useMemo(() => {
    if (!updatesCheckedAt) return "";
    const minutes = Math.floor((Date.now() - updatesCheckedAt) / 60_000);
    if (minutes < 1) return t("skillsPage.justNow");
    try {
      const rtf = new Intl.RelativeTimeFormat(i18n.language, {
        numeric: "auto",
      });
      return minutes < 60
        ? rtf.format(-minutes, "minute")
        : rtf.format(-Math.floor(minutes / 60), "hour");
    } catch {
      return "";
    }
  }, [updatesCheckedAt, i18n.language, t]);

  // ─── 来源 / 筛选 ────────────────────────────────────────────────────
  const sourceKey = (skill: InstalledSkill) =>
    skill.repoOwner && skill.repoName
      ? `repo:${skill.repoOwner}/${skill.repoName}`
      : "local";

  const sourceLabel = (key: string) =>
    key === "local" ? t("skillsPage.source.local") : key.slice(5);

  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of installedSkills) {
      const key = sourceKey(skill);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => {
      if (a === "local") return 1;
      if (b === "local") return -1;
      return a.localeCompare(b);
    });
  }, [installedSkills]);

  const enabledCount = (skill: InstalledSkill) =>
    APP_IDS_WITH.skills.filter((app) => skill.apps[app]).length;

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredSkills = useMemo(() => {
    return installedSkills.filter((skill) => {
      if (statusFilter === "updates" && !updatesMap[skill.id]) return false;
      if (statusFilter === "none" && enabledCount(skill) > 0) return false;
      if (statusFilter.startsWith("app:")) {
        const app = statusFilter.slice(4) as AppId;
        if (!skill.apps[app]) return false;
      }
      if (sourceFilter !== "all" && sourceKey(skill) !== sourceFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [
        skill.name,
        skill.id,
        skill.description,
        skill.directory,
        skill.repoOwner,
        skill.repoName,
        skill.repoOwner && skill.repoName
          ? `${skill.repoOwner}/${skill.repoName}`
          : undefined,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [
    installedSkills,
    statusFilter,
    sourceFilter,
    normalizedQuery,
    updatesMap,
  ]);

  // 「可更新」筛选下把最后一个也更新完：回到全部，免得停在空表上
  const nApplicableUpdates = applicableSkillUpdates.length;
  const prevUpdatesRef = useRef(nApplicableUpdates);
  useEffect(() => {
    if (
      prevUpdatesRef.current > 0 &&
      nApplicableUpdates === 0 &&
      statusFilter === "updates"
    ) {
      setStatusFilter("all");
    }
    prevUpdatesRef.current = nApplicableUpdates;
  }, [nApplicableUpdates, statusFilter]);

  const filtersActive = statusFilter !== "all" || sourceFilter !== "all";
  const scope = resolveBulkScope(
    installedSkills,
    filteredSkills,
    normalizedQuery ? "search" : filtersActive ? "filter" : null,
  );

  // 已经不在列表里的勾选自动丢掉
  useEffect(() => {
    if (selected.size === 0) return;
    const ids = new Set(installedSkills.map((skill) => skill.id));
    const next = new Set([...selected].filter((id) => ids.has(id)));
    if (next.size !== selected.size) setSelected(next);
  }, [installedSkills, selected]);

  // 已安装列表虚拟化：上千行时只画可视区域和前后各几行（每行固定 56）。
  // 不虚拟化的话每次勾选、每次卸载都要重画全部行 × 全部应用列。
  const matrixScrollRef = useRef<HTMLDivElement>(null);
  // 文件夹行和条目行混排；一个文件夹都没有时就是原来的扁平列表
  const displayRows = useMemo(
    () =>
      buildSkillDisplayRows(
        filteredSkills,
        folders,
        folderAssignments,
        collapsedFolders,
        filteredSkills.length !== installedSkills.length,
      ),
    [
      filteredSkills,
      folders,
      folderAssignments,
      collapsedFolders,
      installedSkills.length,
    ],
  );
  const rowVirtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => matrixScrollRef.current,
    estimateSize: (index) =>
      displayRows[index]?.kind === "folder"
        ? FOLDER_ROW_HEIGHT
        : INSTALLED_ROW_HEIGHT,
    getItemKey: (index) => {
      const row = displayRows[index];
      return row ? `${row.kind}:${row.key}` : index;
    },
    // 表头钉在同一个滚动容器里，行从它下面开始
    scrollMargin: MATRIX_HEADER_HEIGHT,
    overscan: 8,
  });

  // 从「发现」跳回来时定位到那一行。那一行可能在可视区域外、还没被画出来，
  // 所以先让虚拟列表滚过去，下一帧再聚焦。
  useEffect(() => {
    if (!highlightId || view !== "installed") return;
    const index = displayRows.findIndex(
      (row) => row.kind === "skill" && row.key === highlightId,
    );
    if (index < 0) {
      // 那一行可能收在折叠的文件夹里：展开它，displayRows 变了这个 effect 会再跑
      if (filteredSkills.some((skill) => skill.id === highlightId)) {
        expandFolder(folderAssignments[highlightId] ?? UNFILED_KEY);
      }
      return;
    }
    rowVirtualizer.scrollToIndex(index, { align: "center" });
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`sk-row-${highlightId}`)
        ?.focus?.({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
    // rowVirtualizer 每次渲染都是新对象，放进依赖会让这个 effect 每帧重跑
  }, [highlightId, view, displayRows]);

  // 在「发现」段按 Escape 回到「已安装」
  useEffect(() => {
    if (view !== "discover") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.body.style.overflow === "hidden") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setView("installed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // ─── 写入与失败记录 ────────────────────────────────────────────────
  const recordResult = (
    id: string,
    app: AppId,
    desired: boolean,
    error?: unknown,
  ) =>
    setFails((prev) => {
      const next = { ...prev };
      const key = failKey(id, app);
      if (error === undefined) delete next[key];
      else next[key] = { desired, error: extractErrorMessage(error) };
      return next;
    });

  const recordEnableFailures = (
    failures: Array<{ id: string; app: AppId; error: unknown }>,
  ) => {
    for (const failure of failures) {
      recordResult(failure.id, failure.app, true, failure.error);
    }
  };

  const writeOne = async (id: string, app: AppId, enabled: boolean) => {
    if (!beginWrite()) return;
    try {
      await toggleAppMutation.mutateAsync({ id, app, enabled });
      recordResult(id, app, enabled);
    } catch (error) {
      recordResult(id, app, enabled, error);
    } finally {
      endWrite();
    }
  };

  const writeMany = async (ids: string[], app: AppId, enabled: boolean) => {
    if (ids.length === 0) return { succeeded: [] as string[], failed: 0 };
    try {
      const result = await bulkToggleAppMutation.mutateAsync({
        ids,
        app,
        enabled,
      });
      for (const id of result.succeeded) recordResult(id, app, enabled);
      for (const failure of result.failed) {
        recordResult(failure.item, app, enabled, failure.error);
      }
      return { succeeded: result.succeeded, failed: result.failed.length };
    } catch (error) {
      for (const id of ids) recordResult(id, app, enabled, error);
      return { succeeded: [] as string[], failed: ids.length };
    }
  };

  const bulkToggle = async (
    ids: string[],
    app: AppId,
    enabled: boolean,
    toastKey: { on: string; off: string },
  ) => {
    if (!beginWrite()) return;
    try {
      const { succeeded, failed } = await writeMany(ids, app, enabled);
      let text = t(enabled ? toastKey.on : toastKey.off, {
        app: APP_DISPLAY_NAME[app],
        count: succeeded.length,
        noun,
      });
      if (failed) text += t("appMatrix.toast.partialFail", { count: failed });
      showUndoToast(
        text,
        t("appMatrix.undo"),
        succeeded.length
          ? () => {
              void (async () => {
                if (!beginWrite()) return;
                try {
                  const result = await writeMany(succeeded, app, !enabled);
                  if (result.failed) {
                    toast[result.succeeded.length ? "warning" : "error"](
                      t("common.bulkToggleFailed", { count: result.failed }),
                      { closeButton: true },
                    );
                  } else {
                    toast.success(t("appMatrix.toast.undone"), {
                      closeButton: true,
                    });
                  }
                } finally {
                  endWrite();
                }
              })();
            }
          : undefined,
        failed ? (succeeded.length ? "warning" : "error") : "success",
      );
    } finally {
      endWrite();
    }
  };

  const handleColumnBulk = (app: AppId, enabled: boolean) => {
    const ids = scope.rows
      .filter((skill) => Boolean(skill.apps[app]) !== enabled)
      .map((skill) => skill.id);
    if (ids.length === 0) return;
    void bulkToggle(ids, app, enabled, {
      on: "appMatrix.toast.enabled",
      off: "appMatrix.toast.disabled",
    });
  };

  // ─── 文件夹 ─────────────────────────────────────────────────────────
  /** 文件夹行上的格子：对整个文件夹批量开关 */
  const handleFolderToggle = (
    members: InstalledSkill[],
    app: AppId,
    enabled: boolean,
  ) => {
    const ids = members
      .filter((skill) => Boolean(skill.apps[app]) !== enabled)
      .map((skill) => skill.id);
    if (ids.length === 0) return;
    void bulkToggle(ids, app, enabled, {
      on: "appMatrix.toast.enabled",
      off: "appMatrix.toast.disabled",
    });
  };

  const handleMoveToFolder = async (ids: string[], folderId: string | null) => {
    if (ids.length === 0) return;
    try {
      await moveToFolderMutation.mutateAsync({ skillIds: ids, folderId });
      const folder = folders.find((item) => item.id === folderId);
      toast.success(
        folder
          ? t("skillFolders.toast.moved", {
              count: ids.length,
              name: folder.name,
            })
          : t("skillFolders.toast.movedOut", { count: ids.length }),
        { closeButton: true },
      );
      setSelected(new Set());
    } catch (error) {
      toast.error(t("skillFolders.toast.failed"), {
        description: String(error),
      });
    }
  };

  const handleFolderNameSubmit = async (name: string) => {
    if (!folderDialog) return;
    try {
      if (folderDialog.mode === "create") {
        const created = await createFolderMutation.mutateAsync(name);
        // 从「移动到… → 新建文件夹」进来的，建完直接把选中的移进去
        if (folderDialog.moveIds.length > 0) {
          await moveToFolderMutation.mutateAsync({
            skillIds: folderDialog.moveIds,
            folderId: created.id,
          });
          setSelected(new Set());
          toast.success(
            t("skillFolders.toast.moved", {
              count: folderDialog.moveIds.length,
              name: created.name,
            }),
            { closeButton: true },
          );
        } else {
          toast.success(
            t("skillFolders.toast.created", { name: created.name }),
            {
              closeButton: true,
            },
          );
        }
      } else {
        await renameFolderMutation.mutateAsync({
          id: folderDialog.folder.id,
          name,
        });
      }
      setFolderDialog(null);
    } catch (error) {
      // 重名之类的校验错误：留着取名框让用户改
      toast.error(t("skillFolders.toast.failed"), {
        description: String(error),
      });
    }
  };

  const handleDeleteFolder = async () => {
    if (!folderToDelete) return;
    const target = folderToDelete;
    setFolderToDelete(null);
    try {
      await deleteFolderMutation.mutateAsync(target.id);
      toast.success(t("skillFolders.toast.deleted", { name: target.name }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("skillFolders.toast.failed"), {
        description: String(error),
      });
    }
  };

  /** 导出成 ZIP，保留文件夹层级。`baseName` 只用来起默认文件名。 */
  const handleExport = async (ids: string[], baseName: string) => {
    if (ids.length === 0) return;
    try {
      const filePath = await skillFoldersApi.pickExportPath(`${baseName}.zip`);
      if (!filePath) return;
      const report = await exportZipMutation.mutateAsync({
        skillIds: ids,
        filePath,
      });
      if (report.missing.length > 0) {
        // 库里有记录但文件没了的导不出来，得说清楚少了哪些
        toast.warning(
          t("skillFolders.toast.exportedPartial", {
            count: report.exported,
            missing: report.missing.length,
          }),
          {
            description: report.missing.slice(0, 5).join(listSeparator),
            closeButton: true,
          },
        );
      } else {
        toast.success(
          t("skillFolders.toast.exported", { count: report.exported }),
          { description: report.path, closeButton: true },
        );
      }
    } catch (error) {
      toast.error(t("skillFolders.toast.exportFailed"), {
        description: String(error),
      });
    }
  };

  const handleSelectionToggle = (app: AppId, enabled: boolean) => {
    const chosen = installedSkills.filter((skill) => selected.has(skill.id));
    const ids = chosen
      .filter((skill) => Boolean(skill.apps[app]) !== enabled)
      .map((skill) => skill.id);
    if (ids.length === 0) {
      toast.info(
        enabled
          ? t("skillsPage.toast.selectionAlreadyOn", {
              count: chosen.length,
              app: APP_DISPLAY_NAME[app],
            })
          : t("skillsPage.toast.selectionAlreadyOff", {
              count: chosen.length,
              app: APP_DISPLAY_NAME[app],
            }),
        { closeButton: true },
      );
      return;
    }
    void bulkToggle(ids, app, enabled, {
      on: "appMatrix.toast.enabled",
      off: "skillsPage.toast.disabledSelection",
    });
  };

  // ─── 卸载 / 更新 ────────────────────────────────────────────────────
  const uninstallIds = async (ids: string[]) => {
    if (!beginWrite(true)) return;
    const done: InstalledSkill[] = [];
    let piWarning: string | undefined;
    let backupPath: string | undefined;
    const byId = new Map(installedSkills.map((item) => [item.id, item]));
    const noteResult = (id: string, result: SkillUninstallResult) => {
      const skill = byId.get(id);
      if (skill) done.push(skill);
      if (result.preservedPiPath) {
        piWarning = t("skills.uninstallPiPreserved", {
          path: result.preservedPiPath,
        });
      } else if (result.piCleanupIncomplete) {
        piWarning = t("skills.uninstallPiCleanupIncomplete");
      }
      if (result.backupPath) backupPath = result.backupPath;
    };
    try {
      if (ids.length === 1) {
        const [id] = ids;
        try {
          noteResult(id, await uninstallMutation.mutateAsync(id));
        } catch (error) {
          toast.error(t("common.error"), {
            description: `${byId.get(id)?.name ?? id}: ${String(error)}`,
          });
        }
      } else {
        // 多选走一次批量调用：逐条调用时每完成一条就重画整表、重扫未管理的
        // Skill，一千多条是平方级的（实测 24 分钟）。
        try {
          const result = await uninstallManyMutation.mutateAsync(ids);
          for (const item of result.succeeded) noteResult(item.id, item);
          if (result.failed.length > 0) {
            // 失败可能有几百条，一条 toast 汇总，不刷屏
            const shown = result.failed
              .slice(0, 3)
              .map(
                (failure) =>
                  `${byId.get(failure.id)?.name ?? failure.id}: ${failure.error}`,
              )
              .join("\n");
            toast.error(
              t("skillsPage.toast.uninstallFailedMany", {
                count: result.failed.length,
              }),
              { description: shown, closeButton: true },
            );
          }
        } catch (error) {
          toast.error(t("common.error"), { description: String(error) });
        }
      }
      setConfirm(null);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    } finally {
      endWrite();
    }
    if (done.length === 0) return;
    const text =
      done.length === 1
        ? t("skills.uninstallSuccess", { name: done[0].name })
        : t("skillsPage.toast.uninstalledMany", { count: done.length });
    const options = {
      description:
        piWarning ??
        (done.length === 1 && backupPath
          ? t("skills.backup.location", { path: backupPath })
          : t("skillsPage.toast.backupAt", { path: BACKUP_DIR })),
      closeButton: true,
    };
    if (piWarning) toast.warning(text, options);
    else toast.success(text, options);
  };

  const updateIds = async (ids: string[], allowOpenDialog = false) => {
    if (ids.length === 0 || !beginWrite(allowOpenDialog)) return;
    // 不让确认框等着整批更新跑完：点了确认就关，每行的 ⋯ 和页头按钮显示进度
    setConfirm(null);
    setIsUpdatingMany(ids.length > 1);
    setUpdateProgress({ done: 0, total: ids.length });
    const updated: string[] = [];
    try {
      for (const [index, id] of ids.entries()) {
        try {
          const result = await updateSkillMutation.mutateAsync(id);
          updated.push(result.name);
        } catch (error) {
          const name = installedSkills.find((skill) => skill.id === id)?.name;
          toast.error(t("skills.updateFailed"), {
            description: `${name ?? id}: ${String(error)}`,
          });
        }
        setUpdateProgress({ done: index + 1, total: ids.length });
      }
    } finally {
      setIsUpdatingMany(false);
      setUpdateProgress(null);
      endWrite();
    }
    if (updated.length === 1) {
      toast.success(t("skills.updateSuccess", { name: updated[0] }), {
        closeButton: true,
      });
    } else if (updated.length > 1) {
      toast.success(t("skills.updateAllSuccess", { count: updated.length }), {
        closeButton: true,
      });
    }
  };

  const handleCheckUpdates = async () => {
    if (
      checkUpdatesLockRef.current ||
      writeLockRef.current ||
      interactionBlocked
    ) {
      return;
    }
    checkUpdatesLockRef.current = true;
    try {
      const result = await checkUpdates();
      const installedIds = new Set(installedSkills.map((skill) => skill.id));
      const updates = (result.data?.updates ?? []).filter((update) =>
        installedIds.has(update.id),
      );
      const failures = result.data?.failures ?? [];
      setDismissedRepoFailAt(null);
      if (updates.length === 0 && failures.length > 0) {
        // 有仓库没读到时不能说「全部最新」；哪些仓库、为什么写在横幅里
        toast.warning(
          t("skills.updatesIncomplete", { count: failures.length }),
          { closeButton: true },
        );
      } else if (updates.length === 0) {
        toast.success(t("skills.noUpdates"), { closeButton: true });
      } else {
        // 查到就直接问要不要全部更新，不用再去筛选里找「全部更新」
        setConfirm({ kind: "updateAll" });
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      checkUpdatesLockRef.current = false;
    }
  };

  // 「立即重新同步」也放在 ⋯ 菜单（#9417）：不用每次打开「存储与同步」对话框
  const handleResyncToApps = async () => {
    if (resyncPending || !beginWrite()) return;
    try {
      await resyncToApps();
    } finally {
      endWrite();
    }
  };

  // ─── 导入 / ZIP / 备份 ───────────────────────────────────────────────
  const handleOpenImport = async () => {
    if (!beginWrite()) return;
    try {
      const result = await scanUnmanaged();
      if (!result.data || result.data.length === 0) {
        toast.success(t("skills.noUnmanagedFound"), { closeButton: true });
        return;
      }
      setImportOpen(true);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleImport = async (imports: ImportSkillSelection[]) => {
    if (!beginWrite(true)) return;
    try {
      const imported = await importMutation.mutateAsync(imports);
      setImportOpen(false);
      toast.success(t("skills.importSuccess", { count: imported.length }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const reportEnableFailures = (
    failures: Array<{ id: string; app: AppId; error: unknown }>,
  ) => {
    if (failures.length === 0) return;
    recordEnableFailures(failures);
    toast.warning(
      t("skillsPage.toast.enableFailed", {
        apps: names([...new Set(failures.map((failure) => failure.app))]),
      }),
      { closeButton: true },
    );
  };

  const handleInstallFromZip = async () => {
    if (!beginWrite()) return;
    try {
      const filePath = await skillsApi.openZipFileDialog();
      if (!filePath) return;
      // 只导入到 CC Switch：不传 currentApp，落 SSOT + 入库，不写任何应用目录。
      // 启用交给用户在「已安装」矩阵里按 Skill 决定，所以这里不走 installTo。
      const { installed, skipped } = await installFromZipMutation.mutateAsync({
        filePath,
      });
      if (skipped.length > 0) {
        // #3749：同名被跳过要说清楚跳过了哪些、被谁占用，不能说成「ZIP 里没有技能」
        const list = skipped
          .map((item) =>
            t("skills.installFromZip.skippedItem", {
              directory: item.directory,
              name: item.existingName,
            }),
          )
          .join(listSeparator);
        toast.warning(
          installed.length === 0
            ? t("skills.installFromZip.allSkipped", { count: skipped.length })
            : t("skills.installFromZip.skippedTitle", {
                count: skipped.length,
              }),
          {
            description: t("skills.installFromZip.skippedBody", { list }),
            closeButton: true,
          },
        );
      }
      if (installed.length === 0) {
        if (skipped.length === 0) {
          toast.info(t("skills.installFromZip.noSkillsFound"), {
            closeButton: true,
          });
        }
      } else if (installed.length === 1) {
        toast.success(
          t("skills.installFromZip.importedSingle", {
            name: installed[0].name,
          }),
          {
            description: t("skills.installFromZip.importedHint"),
            closeButton: true,
          },
        );
      } else {
        toast.success(
          t("skills.installFromZip.importedMultiple", {
            count: installed.length,
          }),
          {
            description: t("skills.installFromZip.importedHint"),
            closeButton: true,
          },
        );
      }
    } catch (error) {
      toast.error(t("skills.installFailed"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleOpenRestoreFromBackup = async () => {
    if (!beginWrite()) return;
    setRestoreOpen(true);
    try {
      await refetchSkillBackups({ throwOnError: true });
    } catch (error) {
      setRestoreOpen(false);
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleRestoreFromBackup = async (backupId: string) => {
    if (!beginWrite(true)) return;
    try {
      const { installed, failures } = await installTo(async (firstApp) => [
        await restoreBackupMutation.mutateAsync({
          backupId,
          currentApp: firstApp,
        }),
      ]);
      setRestoreOpen(false);
      toast.success(
        t("skills.restoreFromBackup.success", { name: installed[0]?.name }),
        { closeButton: true },
      );
      reportEnableFailures(failures);
    } catch (error) {
      toast.error(t("skills.restoreFromBackup.failed"), {
        description: String(error),
      });
    } finally {
      endWrite();
    }
  };

  const confirmDeleteBackup = async (backup: SkillBackupEntry) => {
    if (!beginWrite(true)) return;
    try {
      let deleteSucceeded = false;
      let deleteError: unknown;
      try {
        await deleteBackupMutation.mutateAsync(backup.backupId);
        deleteSucceeded = true;
      } catch (error) {
        deleteError = error;
      }

      // The backups query is disabled by default, so invalidation alone
      // does not fetch authoritative data. Explicitly refresh after both
      // success and failure (remove_dir_all may have made partial progress).
      let refreshedBackups: SkillBackupEntry[] | undefined;
      try {
        const result = await refetchSkillBackups({ throwOnError: true });
        refreshedBackups = result.data;
      } catch (error) {
        // A refresh failure must not turn a completed deletion into a false
        // "delete failed" report, or replace the original deletion error.
        console.error("Failed to refresh Skill backups after deletion:", error);
      }

      if (!deleteSucceeded) {
        if (
          refreshedBackups &&
          !refreshedBackups.some((entry) => entry.backupId === backup.backupId)
        ) {
          setConfirm(null);
        }
        toast.error(t("skills.restoreFromBackup.deleteFailed"), {
          description: String(deleteError),
        });
      } else {
        setConfirm(null);
        toast.success(
          t("skills.restoreFromBackup.deleteSuccess", {
            name: backup.skill.name,
          }),
          { closeButton: true },
        );
      }
    } finally {
      endWrite();
    }
  };

  const openDocs = async (skill: InstalledSkill) => {
    const url =
      skill.readmeUrl ||
      (skill.repoOwner && skill.repoName
        ? `https://github.com/${skill.repoOwner}/${skill.repoName}`
        : undefined);
    if (!url) return;
    try {
      await settingsApi.openExternal(url);
    } catch {
      // ignore
    }
  };

  const copyName = async (skill: InstalledSkill) => {
    try {
      await copyText(skill.name);
      toast.success(t("skillsPage.toast.copiedName", { name: skill.name }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const openDirectory = async (skill: InstalledSkill) => {
    try {
      await skillsApi.openSkillDir(skill.directory);
    } catch (error) {
      toast.error(t("skillsPage.toast.openDirFailed"), {
        description: extractErrorMessage(error),
      });
    }
  };

  const showInstalled = (skillId: string) => {
    setSearchQuery("");
    setStatusFilter("all");
    setSourceFilter("all");
    setView("installed");
    setHighlightId(skillId);
  };

  // ─── 渲染：页头 ─────────────────────────────────────────────────────
  const nInstalled = installedSkills.length;
  const nUpdates = applicableSkillUpdates.length;
  const nUnmanaged = unmanagedSkills?.length ?? 0;
  const loadOk = !isLoading && !isError;
  const selectionActive = selected.size > 0;

  // 可更新的数量只在工具栏的「全部更新（N 个）」上说一次；要只看可更新的，用状态筛选
  const header = (
    <AppPageHeader
      icon={<SkillsIcon size={20} />}
      title="Skills"
      titleExtra={
        <HelpTip title={t("skillsPage.helpTitle")}>
          {t("skillsPage.help")}
        </HelpTip>
      }
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="solid"
                size="regular"
                className="pe-2.5"
                disabled={controlsDisabled}
              >
                <Plus className="h-4 w-4" strokeWidth={2} />
                {t("skillsPage.add")}
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              <DropdownMenuItem onSelect={() => setView("discover")}>
                {t("skillsPage.addMenu.discover")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleInstallFromZip()}>
                {t("skillsPage.addMenu.zip")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleOpenImport()}>
                <span className="flex-1">{t("skillsPage.addMenu.import")}</span>
                {nUnmanaged > 0 && <NeutralBadge>{nUnmanaged}</NeutralBadge>}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <HoverTip content={t("common.more")}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-compact"
                  className="h-8 w-8"
                  aria-label={t("skills.moreActions")}
                >
                  <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </DropdownMenuTrigger>
            </HoverTip>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem
                disabled={controlsDisabled || nInstalled === 0}
                onSelect={() => void handleCheckUpdates()}
              >
                {t("skills.checkUpdates")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={controlsDisabled}
                onSelect={() => void handleOpenRestoreFromBackup()}
              >
                {t("skillsPage.moreMenu.restore")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={controlsDisabled}
                onSelect={() => setRepoManagerOpen(true)}
              >
                {t("skillsPage.moreMenu.repos")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={controlsDisabled || resyncPending || nInstalled === 0}
                onSelect={() => void handleResyncToApps()}
              >
                {t("skills.storageSheet.resync")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setStorageOpen(true)}>
                {t("skills.storageSheet.open")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={controlsDisabled}
                onSelect={() =>
                  setFolderDialog({ mode: "create", moveIds: [] })
                }
              >
                {t("skillFolders.newFolderEllipsis")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={controlsDisabled || nInstalled === 0}
                onSelect={() =>
                  void handleExport(
                    installedSkills.map((skill) => skill.id),
                    t("skillFolders.exportDefaultName"),
                  )
                }
              >
                {t("skillFolders.exportAll")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );

  // 「已安装 / 发现」换的是整块内容：页面级导航，用下划线页签（不是分段控件）。
  // 页签行只渲染一份（两段共用，下划线才滑得过去）；各段右侧的控件用 portal 放进 trailing 槽。
  const [tabsTrailingSlot, setTabsTrailingSlot] =
    useState<HTMLDivElement | null>(null);
  const viewTabsTrailing = (owner: SkillsView, trailing: React.ReactNode) =>
    view === owner && tabsTrailingSlot
      ? createPortal(trailing, tabsTrailingSlot)
      : null;
  const viewTabs = (
    <PageTabs<SkillsView>
      aria-label={t("skillsPage.viewAria")}
      idPrefix="skills-view"
      className="h-11"
      value={view}
      onValueChange={(next) => {
        if (next === "discover" && navigationBlocked) return;
        setView(next);
      }}
      items={[
        {
          value: "installed",
          label: loadOk
            ? t("skillsPage.viewInstalledCount", { count: nInstalled })
            : t("skillsPage.viewInstalled"),
        },
        {
          value: "discover",
          label: t("skillsPage.viewDiscover"),
        },
      ]}
      trailing={<div ref={setTabsTrailingSlot} className="flex items-center" />}
    />
  );

  // ─── 渲染：已安装段 ─────────────────────────────────────────────────
  const statusLabel = (value: StatusFilter) => {
    if (value === "updates") return t("skillsPage.filter.updates");
    if (value === "none") return t("skillsPage.filter.none");
    if (value.startsWith("app:"))
      return t("skillsPage.filter.inApp", {
        app: APP_DISPLAY_NAME[value.slice(4) as AppId],
      });
    return t("skillsPage.filter.all");
  };

  const renderInstalledBody = () => {
    if (isLoading) {
      return (
        <div className="py-12 text-center text-body text-fg-2">
          {t("skills.loading")}
        </div>
      );
    }
    if (isError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-10 pb-12 text-center">
          <h2 className="m-0 text-section">{t("skillsPage.loadFailed")}</h2>
          <code className="max-w-[520px] rounded-[8px] bg-subtle px-3 py-2 text-left font-mono text-caption text-fg-2 [overflow-wrap:anywhere]">
            {extractErrorMessage(loadError) || String(loadError)}
          </code>
          <p className="m-0 text-body text-fg-2">
            {t("mcpPage.noFilesChanged")}
          </p>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            className="mt-1"
            onClick={() => void refetch()}
          >
            {t("common.retry")}
          </Button>
        </div>
      );
    }
    if (nInstalled === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 pb-12 text-center">
          <h2 className="m-0 text-section">{t("skillsPage.emptyTitle")}</h2>
          <p className="m-0 text-body text-fg-2">{t("skillsPage.emptyBody")}</p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="neutral"
              size="regular"
              onClick={() => setView("discover")}
            >
              {t("skillsPage.goDiscover")}
            </Button>
            <Button
              type="button"
              variant="neutral"
              size="regular"
              disabled={controlsDisabled}
              onClick={() => void handleOpenImport()}
            >
              {nUnmanaged
                ? t("skillsPage.importCount", { count: nUnmanaged })
                : t("skillsPage.addMenu.import")}
            </Button>
          </div>
        </div>
      );
    }

    const nVisibleSelected = filteredSkills.filter((skill) =>
      selected.has(skill.id),
    ).length;
    const allVisibleSelected =
      filteredSkills.length > 0 && nVisibleSelected === filteredSkills.length;
    const virtualRows = rowVirtualizer.getVirtualItems();
    const firstRow = virtualRows[0];
    const lastRow = virtualRows[virtualRows.length - 1];
    const virtualPadTop = firstRow
      ? Math.max(0, firstRow.start - MATRIX_HEADER_HEIGHT)
      : 0;
    const virtualPadBottom = lastRow
      ? Math.max(
          0,
          rowVirtualizer.getTotalSize() -
            (lastRow.start - MATRIX_HEADER_HEIGHT) -
            lastRow.size,
        )
      : 0;
    return (
      <div
        ref={matrixScrollRef}
        data-testid="skills-matrix"
        className="min-h-0 overflow-auto scroll-stable rounded-panel border border-border bg-surface"
      >
        <MatrixColumnHighlight>
          {/* 应用列多、窗口窄时整张表横向滚动；名称一栏钉在左边，不跟着被挤掉 */}
          <div style={{ minWidth: matrixMinWidth(appIds.length) }}>
            <div className="sticky top-0 z-20 flex h-11 items-center border-b border-border bg-subtle pe-2">
              <div className="sticky left-0 z-10 flex min-w-0 flex-1 items-center self-stretch bg-subtle ps-2">
                <span className="flex w-6 shrink-0 justify-center">
                  <Checkbox
                    aria-label={t("skillsPage.selectAllAria")}
                    disabled={filteredSkills.length === 0}
                    checked={
                      allVisibleSelected
                        ? true
                        : nVisibleSelected > 0
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={() =>
                      // 只管当前筛选出来的这些行；半选时点一下补齐
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const skill of filteredSkills) {
                          if (allVisibleSelected) next.delete(skill.id);
                          else next.add(skill.id);
                        }
                        return next;
                      })
                    }
                  />
                </span>
                <span className="ms-2 min-w-0 flex-1 truncate text-caption font-semibold text-fg-2">
                  {t("mcpPage.columnName")}
                </span>
              </div>
              <div className="flex shrink-0">
                {appIds.map((app) => {
                  const isPi = app === "pi";
                  const onInScope = scope.rows.filter(
                    (skill) => skill.apps[app],
                  ).length;
                  const appFilter: StatusFilter = `app:${app}`;
                  return (
                    <MatrixColumnHeader
                      key={app}
                      app={app}
                      enabledCount={
                        installedSkills.filter((skill) => skill.apps[app])
                          .length
                      }
                      totalCount={nInstalled}
                      scopeTotal={scope.rows.length}
                      scopeEnabled={onInScope}
                      scopeFailed={
                        scope.rows.filter(
                          (skill) => fails[failKey(skill.id, app)],
                        ).length
                      }
                      scopeKind={scope.kind}
                      noun={noun}
                      disabled={controlsDisabled}
                      title={isPi ? t("skillsPage.piColumnTitle") : undefined}
                      help={
                        isPi
                          ? {
                              title: t("skillsPage.piHelpTitle"),
                              body: t("skillsPage.piHelp"),
                            }
                          : undefined
                      }
                      {...ompDiscoveryColumnNote(app, t)}
                      extraAction={{
                        label:
                          statusFilter === appFilter
                            ? t("skillsPage.pop.showAll")
                            : t("skillsPage.pop.onlyApp", {
                                app: APP_DISPLAY_NAME[app],
                              }),
                        onClick: () =>
                          setStatusFilter(
                            statusFilter === appFilter ? "all" : appFilter,
                          ),
                      }}
                      onEnableRest={() => handleColumnBulk(app, true)}
                      onDisableAll={() => handleColumnBulk(app, false)}
                    />
                  );
                })}
              </div>
              <span aria-hidden="true" className="w-10 shrink-0" />
            </div>

            {filteredSkills.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <h2 className="m-0 text-section">
                  {normalizedQuery
                    ? t("skillsPage.noMatch", { query: searchQuery.trim() })
                    : t("skillsPage.noFilterMatch")}
                </h2>
                <div className="flex flex-wrap justify-center gap-2 pt-1">
                  {normalizedQuery ? (
                    <>
                      <Button
                        type="button"
                        variant="neutral"
                        size="regular"
                        onClick={() => setSearchQuery("")}
                      >
                        {t("mcpPage.clearSearch")}
                      </Button>
                      <Button
                        type="button"
                        variant="neutral"
                        size="regular"
                        onClick={() => {
                          setDiscoverQuery(searchQuery.trim());
                          setSearchQuery("");
                          setView("discover");
                        }}
                      >
                        {t("skillsPage.searchInDiscover", {
                          query: searchQuery.trim(),
                        })}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="neutral"
                      size="regular"
                      onClick={() => {
                        setStatusFilter("all");
                        setSourceFilter("all");
                      }}
                    >
                      {t("skillsPage.clearFilters")}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <ul
                aria-label={t("skillsPage.listLabel")}
                className="m-0 list-none p-0"
                // 没画出来的行用上下留白顶住高度：行仍在正常文档流里，钉在左边的
                // 名称栏和行间分隔线都不用改
                style={{
                  paddingTop: virtualPadTop,
                  paddingBottom: virtualPadBottom,
                }}
              >
                {virtualRows.map(({ index }) => {
                  const row = displayRows[index];
                  if (!row) return null;
                  if (row.kind === "folder") {
                    const { folder } = row;
                    const name = folder?.name ?? t("skillFolders.unfiled");
                    return (
                      <FolderHeaderRow
                        key={`folder:${row.key}`}
                        name={name}
                        skills={row.skills}
                        collapsed={row.collapsed}
                        first={index === 0}
                        appIds={appIds}
                        disabled={controlsDisabled}
                        onToggleCollapsed={() => toggleFolder(row.key)}
                        onCell={(app, enable) =>
                          handleFolderToggle(row.skills, app, enable)
                        }
                        onExport={() =>
                          void handleExport(
                            row.skills.map((skill) => skill.id),
                            name,
                          )
                        }
                        onRename={
                          folder
                            ? () => setFolderDialog({ mode: "rename", folder })
                            : undefined
                        }
                        onDelete={
                          folder ? () => setFolderToDelete(folder) : undefined
                        }
                      />
                    );
                  }
                  const { skill } = row;
                  return (
                    <InstalledRow
                      key={skill.id}
                      skill={skill}
                      first={index === 0}
                      appIds={appIds}
                      checked={selected.has(skill.id)}
                      hasUpdate={Boolean(updatesMap[skill.id])}
                      isUpdating={
                        updateSkillMutation.isPending &&
                        updateSkillMutation.variables === skill.id
                      }
                      highlighted={highlightId === skill.id}
                      onHighlightDone={() => setHighlightId(null)}
                      fails={fails}
                      disabled={controlsDisabled}
                      sourceText={
                        skill.repoOwner && skill.repoName
                          ? `${skill.repoOwner}/${skill.repoName}`
                          : t("skillsPage.source.local")
                      }
                      onPick={(checked) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(skill.id);
                          else next.delete(skill.id);
                          return next;
                        })
                      }
                      onCell={(app) => {
                        const failure = fails[failKey(skill.id, app)];
                        void writeOne(
                          skill.id,
                          app,
                          failure ? failure.desired : !skill.apps[app],
                        );
                      }}
                      onOpenSource={() => void openDocs(skill)}
                      onFixSync={() => setStorageOpen(true)}
                      onUpdate={() => void updateIds([skill.id])}
                      onOpenDocs={() => void openDocs(skill)}
                      onCopyName={() => void copyName(skill)}
                      onOpenDir={() => void openDirectory(skill)}
                      onUninstall={() => {
                        if (writeLockRef.current || interactionBlocked) return;
                        setConfirm({ kind: "uninstall", ids: [skill.id] });
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </MatrixColumnHighlight>
      </div>
    );
  };

  const showUnmanagedBanner =
    nUnmanaged > 0 && dismissedUnmanaged !== nUnmanaged && nInstalled > 0;
  const showUpdateRepoFailBanner =
    updateRepoFailures.length > 0 && dismissedRepoFailAt !== updatesCheckedAt;
  const showNotices = showUnmanagedBanner || showUpdateRepoFailBanner;
  const showInstalledToolbar = loadOk && nInstalled > 0;

  const uninstallTargets =
    confirm?.kind === "uninstall"
      ? installedSkills.filter((skill) => confirm.ids.includes(skill.id))
      : [];

  return (
    <>
      {header}
      <div id="main-content" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 px-6">
          <ProjectScopeSelector
            projects={scopedProjects}
            projectId={scopeProjectId}
            onSelect={selectScope}
            disabled={controlsDisabled}
          />
        </div>
        {scopeProjectId ? (
          <div className="flex min-h-0 flex-1 flex-col px-6 pb-5">
            <ProjectScopeMatrix
              kind="skill"
              projectId={scopeProjectId}
              disabled={controlsDisabled}
            />
          </div>
        ) : (
          <>
            <div className="shrink-0 px-6 pt-1">{viewTabs}</div>
            {/* 两段打开过就一直挂着，切回来不重新加载；不在看的那段只是隐藏 */}
            {discoverMounted && (
              <div
                className={cn(
                  "min-h-0 flex-1 flex-col",
                  view === "discover" ? "flex" : "hidden",
                )}
              >
                <SkillsPage
                  key={discoverQuery}
                  initialQuery={discoverQuery}
                  renderViewTabs={(trailing) =>
                    viewTabsTrailing("discover", trailing)
                  }
                  visibleAppIds={appIds}
                  installTargets={targets}
                  onInstallTargetsChange={setTargets}
                  installTo={installTo}
                  onShowInstalled={showInstalled}
                  onOpenRepoManager={() => setRepoManagerOpen(true)}
                  onEnableFailures={recordEnableFailures}
                />
              </div>
            )}
            <div
              className={cn(
                "min-h-0 flex-1 flex-col",
                view === "installed" ? "flex" : "hidden",
              )}
            >
              {viewTabsTrailing(
                "installed",
                showInstalledToolbar ? (
                  <MatrixSearch
                    className="w-[280px] min-w-[160px] shrink"
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    placeholder={t("skillsPage.searchPlaceholder")}
                    ariaLabel={t("skills.installedSearchAriaLabel")}
                    status={
                      normalizedQuery
                        ? t("appMatrix.found", {
                            count: filteredSkills.length,
                          })
                        : ""
                    }
                  />
                ) : null,
              )}

              {/* 页签下面一行，和「发现」段同高：左边筛选一直在，右边是更新入口；勾选了行就换成批量操作。
              窄窗口 + 大缩放时两边放不下就把右边整组折到下一行，不叠在一起 */}
              {showInstalledToolbar && (
                <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-6 py-2">
                  <div className="-ms-2.5 flex min-w-0 items-center gap-0.5">
                    <FilterMenu
                      label={statusLabel(statusFilter)}
                      active={statusFilter !== "all"}
                      items={(["all", "updates", "none"] as StatusFilter[]).map(
                        (value) => ({
                          key: value,
                          label: statusLabel(value),
                          checked: statusFilter === value,
                          onSelect: () => setStatusFilter(value),
                        }),
                      )}
                    />
                    <FilterMenu
                      label={t("skillsPage.filter.sourceButton", {
                        source:
                          sourceFilter === "all"
                            ? t("skillsPage.filter.all")
                            : sourceLabel(sourceFilter),
                      })}
                      active={sourceFilter !== "all"}
                      items={[
                        {
                          key: "all",
                          label: t("skillsPage.filter.all"),
                          checked: sourceFilter === "all",
                          onSelect: () => setSourceFilter("all"),
                        },
                        ...sourceOptions.map(([key, count]) => ({
                          key,
                          label: sourceLabel(key),
                          mono: key !== "local",
                          count,
                          checked: sourceFilter === key,
                          onSelect: () => setSourceFilter(key),
                        })),
                      ]}
                    />
                  </div>
                  <div className="flex-1" />
                  {updateProgress ? (
                    <Button
                      type="button"
                      variant="neutral"
                      size="regular"
                      className="shrink-0"
                      disabled
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("skillsPage.updatingProgress", {
                        done: Math.min(
                          updateProgress.done + 1,
                          updateProgress.total,
                        ),
                        total: updateProgress.total,
                      })}
                    </Button>
                  ) : selectionActive ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-0.5">
                      <span className="shrink-0 whitespace-nowrap pe-1.5 text-body font-medium tabular-nums">
                        {t("skillsPage.bulk.selected", {
                          count: selected.size,
                        })}
                      </span>
                      {/* 列头的批量只按筛选范围走；挑着勾的几行要一次启用到 / 停用某个应用，走这里 */}
                      <AppMenuButton
                        label={t("skillsPage.bulk.enableTo")}
                        ariaLabel={t("skillsPage.bulk.enableToAria", {
                          count: selected.size,
                        })}
                        apps={appIds}
                        disabled={controlsDisabled}
                        onPick={(app) => handleSelectionToggle(app, true)}
                      />
                      <AppMenuButton
                        label={t("skillsPage.bulk.disable")}
                        ariaLabel={t("skillsPage.bulk.disableAria", {
                          count: selected.size,
                        })}
                        apps={appIds}
                        disabled={controlsDisabled}
                        onPick={(app) => handleSelectionToggle(app, false)}
                      />
                      <Button
                        type="button"
                        variant="quiet"
                        size="compact"
                        className="px-2"
                        disabled={controlsDisabled}
                        onClick={() => {
                          const ids = [...selected].filter(
                            (id) => updatesMap[id],
                          );
                          if (ids.length === 0) {
                            toast.info(
                              t("skillsPage.toast.noUpdatesInSelection"),
                              {
                                closeButton: true,
                              },
                            );
                            return;
                          }
                          void updateIds(ids);
                        }}
                      >
                        {t("skills.update")}
                      </Button>
                      <MoveToFolderMenu
                        folders={folders}
                        disabled={controlsDisabled}
                        onPick={(folderId) =>
                          void handleMoveToFolder([...selected], folderId)
                        }
                        onCreate={() =>
                          setFolderDialog({
                            mode: "create",
                            moveIds: [...selected],
                          })
                        }
                      />
                      <Button
                        type="button"
                        variant="quiet"
                        size="compact"
                        className="px-2"
                        disabled={controlsDisabled}
                        onClick={() =>
                          void handleExport(
                            [...selected],
                            t("skillFolders.exportDefaultName"),
                          )
                        }
                      >
                        {t("skillFolders.exportSelected")}
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        size="compact"
                        className="px-2 text-danger-text hover:text-danger-text"
                        disabled={controlsDisabled}
                        onClick={() =>
                          setConfirm({ kind: "uninstall", ids: [...selected] })
                        }
                      >
                        {t("skillsPage.bulk.uninstall")}
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        size="compact"
                        className="px-2 text-fg-2"
                        onClick={() => setSelected(new Set())}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <HoverTip
                      content={
                        lastCheckedText
                          ? t("skillsPage.lastChecked", {
                              when: lastCheckedText,
                            })
                          : undefined
                      }
                    >
                      {/* 已知有更新时这颗按钮就是「全部更新」；想重新检查走「⋯」菜单 */}
                      {nUpdates > 0 && !isCheckingUpdates ? (
                        <Button
                          type="button"
                          variant="neutral"
                          size="regular"
                          className="shrink-0"
                          disabled={controlsDisabled}
                          onClick={() => setConfirm({ kind: "updateAll" })}
                        >
                          <ArrowUpCircle className="h-4 w-4" strokeWidth={2} />
                          {t("skillsPage.updateAllCount", { count: nUpdates })}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="quiet"
                          size="regular"
                          className="shrink-0"
                          disabled={controlsDisabled}
                          onClick={() => void handleCheckUpdates()}
                        >
                          {isCheckingUpdates ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" strokeWidth={2} />
                          )}
                          {isCheckingUpdates
                            ? t("skills.checkingUpdates")
                            : t("skills.checkUpdates")}
                        </Button>
                      )}
                    </HoverTip>
                  )}
                </div>
              )}

              <NoticeSlot
                className={cn(
                  showNotices && "px-6 pb-3",
                  showNotices && !showInstalledToolbar && "pt-3",
                )}
              >
                {showUpdateRepoFailBanner && (
                  <Notice
                    tone="warning"
                    title={t("skillsPage.repoFail.title", {
                      count: updateRepoFailures.length,
                      repos: describeRepoFailures(updateRepoFailures, t),
                    })}
                    actions={
                      <Button
                        type="button"
                        variant="neutral"
                        size="compact"
                        disabled={controlsDisabled}
                        onClick={() => void handleCheckUpdates()}
                      >
                        {t("common.retry")}
                      </Button>
                    }
                    onDismiss={() => setDismissedRepoFailAt(updatesCheckedAt)}
                    dismissLabel={t("skillsPage.banner.close")}
                  >
                    {t("skillsPage.repoFail.updatesBody")}
                  </Notice>
                )}
                {showUnmanagedBanner && (
                  <Notice
                    title={t("skillsPage.banner.unmanaged", {
                      count: nUnmanaged,
                    })}
                    actions={
                      <>
                        <Button
                          type="button"
                          variant="quiet"
                          size="compact"
                          disabled={controlsDisabled}
                          onClick={() => void handleOpenImport()}
                        >
                          {t("skillsPage.banner.reviewImport")}
                        </Button>
                        <Button
                          type="button"
                          variant="quiet"
                          size="compact"
                          className="text-fg-2"
                          onClick={() => setDismissedUnmanaged(nUnmanaged)}
                        >
                          {t("skillsPage.banner.ignore")}
                        </Button>
                      </>
                    }
                  />
                )}
              </NoticeSlot>

              <div
                className={cn(
                  "flex min-h-0 flex-1 flex-col px-6 pb-5",
                  !showInstalledToolbar && !showNotices && "pt-3",
                )}
              >
                {renderInstalledBody()}
              </div>
            </div>
          </>
        )}
      </div>

      <FolderNameDialog
        open={folderDialog !== null}
        title={t(
          folderDialog?.mode === "rename"
            ? "skillFolders.renameTitle"
            : "skillFolders.newFolderTitle",
        )}
        confirmLabel={t(
          folderDialog?.mode === "rename"
            ? "skillFolders.rename"
            : "skillFolders.create",
        )}
        initialName={
          folderDialog?.mode === "rename" ? folderDialog.folder.name : ""
        }
        pending={
          createFolderMutation.isPending ||
          renameFolderMutation.isPending ||
          moveToFolderMutation.isPending
        }
        onSubmit={(name) => void handleFolderNameSubmit(name)}
        onCancel={() => setFolderDialog(null)}
      />
      <V7ConfirmDialog
        open={folderToDelete !== null}
        // 只是解散分组，里面的 Skill 一个都不卸载：不用红色确认键
        danger={false}
        title={t("skillFolders.deleteTitle", {
          name: folderToDelete?.name ?? "",
        })}
        body={t("skillFolders.deleteBody")}
        confirmLabel={t("skillFolders.delete")}
        pending={deleteFolderMutation.isPending}
        onConfirm={() => void handleDeleteFolder()}
        onCancel={() => setFolderToDelete(null)}
      />
      <V7ConfirmDialog
        open={confirm?.kind === "uninstall"}
        // 卸载前会备份、能从备份恢复：可恢复操作，不用红色确认键
        danger={false}
        title={
          uninstallTargets.length === 1
            ? t("skillsPage.confirm.uninstallOne", {
                name: uninstallTargets[0].name,
              })
            : t("skillsPage.confirm.uninstallMany", {
                count: uninstallTargets.length,
              })
        }
        body={t("skillsPage.confirm.uninstallBody", { path: BACKUP_DIR })}
        confirmLabel={
          uninstallTargets.length === 1
            ? t("skills.uninstall")
            : t("skillsPage.confirm.uninstallManyButton", {
                count: uninstallTargets.length,
              })
        }
        pending={writePending}
        onConfirm={() =>
          confirm?.kind === "uninstall" && void uninstallIds(confirm.ids)
        }
        onCancel={() => setConfirm(null)}
      />

      <V7ConfirmDialog
        open={confirm?.kind === "updateAll"}
        danger={false}
        title={t("skillsPage.confirm.updateAll", { count: nUpdates })}
        body={t("skillsPage.confirm.updateBody", { path: BACKUP_DIR })}
        details={
          <ul
            aria-label={t("skillsPage.confirm.updateListAria")}
            className="max-h-60 divide-y divide-border overflow-y-auto rounded-control border border-border"
          >
            {applicableSkillUpdates.map((update) => {
              const skill = installedSkills.find(
                (item) => item.id === update.id,
              );
              const repo =
                skill?.repoOwner && skill.repoName
                  ? `${skill.repoOwner}/${skill.repoName}`
                  : null;
              return (
                <li
                  key={update.id}
                  className="flex items-baseline gap-2 px-3 py-2 text-body"
                >
                  <span className="min-w-0 truncate font-medium text-fg-1">
                    {skill?.name ?? update.name}
                  </span>
                  {repo && skill && (
                    // 和列表行的来源链接一样：有 README 地址开 README，否则开仓库首页
                    <button
                      type="button"
                      onClick={() => void openDocs(skill)}
                      className="ms-auto shrink-0 rounded-sm font-mono text-caption text-fg-3 underline decoration-border-strong underline-offset-[3px] hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {repo}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        }
        confirmLabel={t("skillsPage.confirm.updateAllButton", {
          count: nUpdates,
        })}
        pending={writePending || isUpdatingMany}
        onConfirm={() =>
          void updateIds(
            applicableSkillUpdates.map((update) => update.id),
            true,
          )
        }
        onCancel={() => setConfirm(null)}
      />

      {importOpen && unmanagedSkills && (
        <SkillImportDialog
          skills={unmanagedSkills}
          visibleAppIds={appIds}
          isImporting={importMutation.isPending}
          onImport={(imports) => void handleImport(imports)}
          onClose={() => setImportOpen(false)}
        />
      )}

      <SkillRestoreDialog
        open={restoreOpen}
        backups={skillBackups}
        isLoading={isFetchingSkillBackups}
        isRestoring={restoreBackupMutation.isPending}
        isDeleting={deleteBackupMutation.isPending}
        targetsLabel={names(targets)}
        onRestore={(backupId) => void handleRestoreFromBackup(backupId)}
        onDelete={(backup) => {
          if (checkUpdatesLockRef.current || writeLockRef.current) return;
          setConfirm({ kind: "deleteBackup", backup });
        }}
        onClose={() => setRestoreOpen(false)}
      />

      <V7ConfirmDialog
        open={confirm?.kind === "deleteBackup"}
        title={t("skills.restoreFromBackup.deleteConfirmTitle")}
        body={
          confirm?.kind === "deleteBackup"
            ? t("skills.restoreFromBackup.deleteConfirmMessage", {
                name: confirm.backup.skill.name,
              })
            : ""
        }
        confirmLabel={t("skills.restoreFromBackup.delete")}
        pending={writePending}
        onConfirm={() =>
          confirm?.kind === "deleteBackup" &&
          void confirmDeleteBackup(confirm.backup)
        }
        onCancel={() => setConfirm(null)}
      />

      <SkillsStorageSheet open={storageOpen} onOpenChange={setStorageOpen} />

      {repoManagerOpen && (
        <RepoManagerContainer onClose={() => setRepoManagerOpen(false)} />
      )}
    </>
  );
};

UnifiedSkillsPanel.displayName = "UnifiedSkillsPanel";

// ─── 已安装的一行 ────────────────────────────────────────────────────────
interface InstalledRowProps {
  skill: InstalledSkill;
  first: boolean;
  appIds: AppId[];
  checked: boolean;
  hasUpdate: boolean;
  isUpdating: boolean;
  highlighted: boolean;
  /** 闪烁结束后清掉，下次跳到同一行还能再闪 */
  onHighlightDone: () => void;
  fails: Record<string, WriteFailure>;
  disabled: boolean;
  sourceText: string;
  onPick: (checked: boolean) => void;
  onCell: (app: AppId) => void;
  onOpenSource: () => void;
  onFixSync: () => void;
  onUpdate: () => void;
  onOpenDocs: () => void;
  onCopyName: () => void;
  onOpenDir: () => void;
  onUninstall: () => void;
}

function InstalledRow({
  skill,
  first,
  appIds,
  checked,
  hasUpdate,
  isUpdating,
  highlighted,
  onHighlightDone,
  fails,
  disabled,
  sourceText,
  onPick,
  onCell,
  onOpenSource,
  onFixSync,
  onUpdate,
  onOpenDocs,
  onCopyName,
  onOpenDir,
  onUninstall,
}: InstalledRowProps) {
  const { t } = useTranslation();
  const enabled = APP_IDS_WITH.skills.some((app) => skill.apps[app]);
  const failedApp = appIds.find((app) => fails[failKey(skill.id, app)]);
  const failure = failedApp ? fails[failKey(skill.id, failedApp)] : undefined;
  const failId = `sk-fail-${skill.id}`;
  const hasRepo = Boolean(skill.repoOwner && skill.repoName);

  return (
    <li
      id={`sk-row-${skill.id}`}
      tabIndex={-1}
      className={cn(
        "group relative flex h-14 items-center pe-2 outline-none transition-colors duration-150 hover:bg-subtle",
        !first && "border-t border-border",
        // 黄色垫在内容下面的一层，靠它的透明度闪
        highlighted &&
          "isolate before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-warning-soft before:opacity-0 before:content-[''] before:animate-row-flash motion-reduce:before:animate-row-fade",
      )}
      onAnimationEnd={(event) => {
        if (highlighted && event.target === event.currentTarget) {
          onHighlightDone();
        }
      }}
    >
      {/* 横向滚动时这一块钉在左边，自带底色盖住滚过去的应用列；
          底色会挡住行上的闪烁层，所以这里自己再垫一层同步闪 */}
      <div
        className={cn(
          "sticky left-0 z-[1] flex min-w-0 flex-1 items-center self-stretch bg-surface ps-2 transition-colors duration-150 group-hover:bg-subtle",
          highlighted &&
            "isolate before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-warning-soft before:opacity-0 before:content-[''] before:animate-row-flash motion-reduce:before:animate-row-fade",
        )}
      >
        <span className="flex w-6 shrink-0 justify-center">
          <input
            type="checkbox"
            // 勾选框一直显示，不等悬停（批量操作入口要看得见）
            className="ui-checkbox"
            aria-label={t("skillsPage.selectAria", { name: skill.name })}
            checked={checked}
            onChange={(event) => onPick(event.target.checked)}
          />
        </span>
        <div className="ms-2 flex min-w-0 flex-1 flex-col pe-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onCopyName}
              className="min-w-0 cursor-copy truncate text-start text-body font-medium hover:text-fg-1 hover:underline hover:underline-offset-[3px]"
            >
              {skill.name}
            </button>
            {hasRepo ? (
              <button
                type="button"
                onClick={onOpenSource}
                title={sourceText}
                className="min-w-0 shrink truncate font-mono text-caption text-fg-3 hover:text-fg-1 hover:underline hover:underline-offset-[3px]"
              >
                {sourceText}
              </button>
            ) : (
              <span className="shrink-0 text-caption text-fg-3">
                {sourceText}
              </span>
            )}
            {/* 「可更新」本身就是更新按钮，不用再去「⋯」里找 */}
            {hasUpdate && (
              <HoverTip content={t("skills.update")}>
                <button
                  type="button"
                  aria-label={t("skillsPage.rowUpdateAria", {
                    name: skill.name,
                  })}
                  disabled={disabled || isUpdating}
                  onClick={onUpdate}
                  className="inline-flex h-[18px] shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-transparent bg-warning-soft px-1.5 text-badge font-medium text-warning-text transition-colors duration-150 hover:border-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isUpdating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowUpCircle className="h-3 w-3" strokeWidth={2} />
                  )}
                  {t("skills.updateAvailable")}
                </button>
              </HoverTip>
            )}
            {!enabled && <NeutralBadge>{t("mcpPage.notEnabled")}</NeutralBadge>}
          </div>
          {/* 写入失败时整行第二行换成失败原因：接在描述后面会先被截掉 */}
          {failure && failedApp ? (
            <div className="flex min-w-0 whitespace-nowrap text-caption text-warning-text">
              <span
                id={failId}
                className="min-w-0 truncate"
                title={failure.error}
              >
                {t("skillsPage.rowFail", {
                  app: APP_DISPLAY_NAME[failedApp],
                  error: failure.error,
                })}
              </span>
              <span aria-hidden="true" className="shrink-0">
                &nbsp;·&nbsp;
              </span>
              <button
                type="button"
                aria-describedby={failId}
                onClick={onFixSync}
                className="shrink-0 underline underline-offset-[3px]"
              >
                {t("skillsPage.fixSync")}
              </button>
            </div>
          ) : (
            <div className="flex min-w-0 whitespace-nowrap text-caption text-fg-2">
              {skill.description && (
                <span className="min-w-0 truncate" title={skill.description}>
                  {skill.description}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0">
        {appIds.map((app) => {
          const fail = fails[failKey(skill.id, app)];
          const on = Boolean(skill.apps[app]);
          const state = fail ? "fail" : on ? "on" : "off";
          return (
            <MatrixCell
              key={app}
              app={app}
              state={state}
              disabled={disabled}
              label={t(`appMatrix.cell.${state}`, {
                name: skill.name,
                app: APP_DISPLAY_NAME[app],
              })}
              onClick={() => onCell(app)}
            />
          );
        })}
      </div>
      {/* 行尾「⋯」：更新已经是第一行的「可更新」徽标，这里放打开文档、打开目录和单个卸载 */}
      <div className="flex w-10 shrink-0 justify-end">
        <DropdownMenu>
          <HoverTip content={t("common.more")}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="icon-compact"
                aria-label={t("skillsPage.rowMoreAria", { name: skill.name })}
                disabled={disabled}
              >
                <MoreHorizontal
                  className="h-[15px] w-[15px]"
                  strokeWidth={1.5}
                />
              </Button>
            </DropdownMenuTrigger>
          </HoverTip>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            {(skill.readmeUrl || hasRepo) && (
              <DropdownMenuItem onSelect={onOpenDocs}>
                {t("mcpPage.openDocs")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onOpenDir}>
              {t("skillsPage.openDir")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-danger-text focus:text-danger-text"
              onSelect={onUninstall}
            >
              {t("skillsPage.uninstallEllipsis")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

// ─── 列头左侧的筛选按钮 ──────────────────────────────────────────────────
function FilterMenu({
  label,
  active,
  items,
}: {
  label: string;
  active: boolean;
  items: Array<{
    key: string;
    label: string;
    checked: boolean;
    onSelect: () => void;
    count?: number;
    mono?: boolean;
  }>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          className={cn(
            "shrink-0 pe-1.5 ps-2.5",
            active ? "text-fg-1" : "text-fg-2",
          )}
        >
          <span className="max-w-[180px] truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[210px] max-w-[280px]"
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.key} onSelect={item.onSelect}>
            <span className="flex w-4 shrink-0 justify-center">
              {item.checked && (
                <Check className="h-3.5 w-3.5" strokeWidth={2} />
              )}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                item.mono && "font-mono text-caption",
              )}
            >
              {item.label}
            </span>
            {item.count !== undefined && (
              <span className="shrink-0 text-caption tabular-nums text-fg-3">
                {item.count}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── 多选条的「启用到 / 停用」应用菜单 ────────────────────────────────────
function AppMenuButton({
  label,
  ariaLabel,
  apps,
  disabled,
  onPick,
}: {
  label: string;
  ariaLabel: string;
  apps: AppId[];
  disabled: boolean;
  onPick: (app: AppId) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          className="shrink-0 pe-1.5 ps-2"
          disabled={disabled}
        >
          {label}
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={ariaLabel}
        className="min-w-[200px]"
      >
        {apps.map((app) => (
          <DropdownMenuItem key={app} onSelect={() => onPick(app)}>
            <AppGlyph app={app} size={16} badgeClassName="bg-surface" />
            {APP_DISPLAY_NAME[app]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── 仓库管理抽屉（打开时才挂载，避免进页面就去读仓库） ─────────────────────
function RepoManagerContainer({ onClose }: { onClose: () => void }) {
  const { data: repos = [] } = useSkillRepos();
  const { data: discoverable = [] } = useDiscoverableSkills();
  const { data: failures = [] } = useDiscoverableSkillsFailures();
  const { addRepo, removeRepo, setRepoEnabled } = useSkillRepoActions();
  return (
    <RepoManagerPanel
      repos={repos}
      skills={discoverable}
      failures={failures}
      onAdd={addRepo}
      onRemove={removeRepo}
      onToggle={setRepoEnabled}
      onClose={onClose}
    />
  );
}

export default UnifiedSkillsPanel;
