import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Notice, NoticeSlot } from "@/components/ui/notice";
import { V7ConfirmDialog } from "@/components/mcp/formBits";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import {
  MatrixCell,
  MatrixColumnHighlight,
  MatrixSearch,
  type MatrixCellState,
} from "@/components/mcp/AppMatrix";
import { cn } from "@/lib/utils";
import {
  useBulkToggleProjectItems,
  useProjectScopeState,
  useResyncProjectScope,
  useToggleProjectMcp,
  useToggleProjectSkill,
} from "@/hooks/useProjectScope";
import { useCollapsedFolders, useFolders } from "@/hooks/useFolders";
import {
  buildFolderDisplayRows,
  type FolderAppState,
} from "@/components/common/folders";
import type {
  ProjectCell,
  ProjectItemState,
  ProjectScopeApp,
  ToggleOutcome,
} from "@/lib/api/projectScope";

/** 项目级第一版只有这两列 */
const COLUMNS: ProjectScopeApp[] = ["claude", "codex"];

function cellState(cell: ProjectCell): MatrixCellState {
  if (cell.bound) return "on";
  // 同名冲突：点下去会先问，不是失败态，但要先让人看见
  if (cell.conflict) return "fail";
  if (cell.global) return "inherited";
  return "off";
}

/** 文件夹在这个项目某应用下的整体绑定状态 */
function folderBindState(
  members: ProjectItemState[],
  app: ProjectScopeApp,
): FolderAppState {
  if (members.length === 0) return "none";
  const bound = members.filter((row) =>
    app === "claude" ? row.claude.bound : row.codex.bound,
  ).length;
  if (bound === 0) return "none";
  return bound === members.length ? "all" : "some";
}

const FOLDER_CELL_STATE: Record<FolderAppState, MatrixCellState> = {
  all: "on",
  some: "inherited",
  none: "off",
};

/** 等用户确认的同名冲突 */
interface PendingConflict {
  row: ProjectItemState;
  app: ProjectScopeApp;
  key: string;
  path: string;
}

/**
 * 一个项目的 MCP / Skills 矩阵：行 = 条目，列 = Claude Code / Codex。
 *
 * 格子四态：
 * - 空框 = 未启用
 * - 实心勾 = 项目级已绑定（CC Switch 写进了这个仓库）
 * - 淡色虚线勾 = 全局已启用、项目里没单独绑（继承态）
 * - ⚠ = 仓库里已有同名条目但不是 CC Switch 写的，不会去覆盖
 */
export function ProjectScopeMatrix({
  kind,
  projectId,
  disabled,
}: {
  kind: "mcp" | "skill";
  projectId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const {
    data: state,
    isLoading,
    isError,
    error,
  } = useProjectScopeState(projectId);
  const toggleMcp = useToggleProjectMcp();
  const toggleSkill = useToggleProjectSkill();
  const resync = useResyncProjectScope();
  const bulkItems = useBulkToggleProjectItems();
  // 和全局面板是同一套文件夹、同一份折叠状态：文件夹是条目的收纳方式，不分
  // 作用域。Skills 和 MCP 各有各的文件夹，这里按当前看的是哪一类来取。
  const folderScope = kind === "mcp" ? "mcp" : "skills";
  const folderNs = kind === "mcp" ? "mcpFolders" : "skillFolders";
  const { data: folderState } = useFolders(folderScope);
  const { collapsed: collapsedFolders, toggle: toggleFolder } =
    useCollapsedFolders(folderScope);
  const [search, setSearch] = React.useState("");
  const [conflict, setConflict] = React.useState<PendingConflict | null>(null);

  const busy =
    disabled ||
    toggleMcp.isPending ||
    toggleSkill.isPending ||
    bulkItems.isPending ||
    resync.isPending;

  const rows: ProjectItemState[] = React.useMemo(() => {
    if (!state) return [];
    return kind === "mcp" ? state.mcp : state.skills;
  }, [state, kind]);

  const query = search.trim().toLowerCase();
  const visibleRows = React.useMemo(
    () =>
      query
        ? rows.filter(
            (row) =>
              row.name.toLowerCase().includes(query) ||
              row.id.toLowerCase().includes(query),
          )
        : rows,
    [rows, query],
  );

  const write = async (
    row: ProjectItemState,
    app: ProjectScopeApp,
    enabled: boolean,
    force: boolean,
  ): Promise<ToggleOutcome> =>
    kind === "mcp"
      ? await toggleMcp.mutateAsync({
          projectId,
          serverId: row.id,
          app,
          enabled,
          force,
        })
      : await toggleSkill.mutateAsync({
          projectId,
          skillId: row.id,
          app,
          enabled,
          force,
        });

  const handleToggle = async (
    row: ProjectItemState,
    app: ProjectScopeApp,
    cell: ProjectCell,
  ) => {
    const enabled = !cell.bound;
    try {
      const outcome = await write(row, app, enabled, false);
      if (outcome.status === "conflict") {
        // 仓库里已经有同名的东西：不判断那是谁写的，问一句再说
        setConflict({ row, app, key: outcome.key, path: outcome.path });
        return;
      }
      // 项目级覆盖全局是 Claude / Codex 自己的作用域规则，用户该知道这件事
      if (enabled && cell.global) {
        toast.info(
          t("projectScope.overridesGlobal", {
            name: row.name,
            app: APP_DISPLAY_NAME[app],
          }),
          { closeButton: true },
        );
      }
    } catch (toggleError) {
      toast.error(t("projectScope.toggleFailed", { name: row.name }), {
        description: String(toggleError),
      });
    }
  };

  const displayRows = React.useMemo(
    () =>
      buildFolderDisplayRows(
        visibleRows,
        folderState?.folders ?? [],
        folderState?.assignments ?? {},
        collapsedFolders,
        Boolean(query),
      ),
    [visibleRows, folderState, collapsedFolders, query],
  );

  /** 文件夹行上的格子：把整个文件夹在这个项目里统一绑定 / 解绑 */
  const handleFolderToggle = async (
    members: ProjectItemState[],
    app: ProjectScopeApp,
    enable: boolean,
  ) => {
    const itemIds = members
      .filter(
        (row) =>
          (app === "claude" ? row.claude.bound : row.codex.bound) !== enable,
      )
      .map((row) => row.id);
    if (itemIds.length === 0) return;
    // 两类的措辞不同（Skill 是目录、MCP 是配置文件里的条目）
    const bulkNs =
      kind === "mcp" ? "mcpFolders.bulk" : "projectScope.folderBulk";
    try {
      const result = await bulkItems.mutateAsync({
        kind,
        projectId,
        itemIds,
        app,
        enabled: enable,
      });
      const notes: string[] = [];
      if (result.conflicts.length > 0) {
        notes.push(
          t(`${bulkNs}.conflicts`, {
            count: result.conflicts.length,
          }),
        );
      }
      if (result.failed.length > 0) {
        notes.push(
          t(`${bulkNs}.failed`, {
            count: result.failed.length,
            error: result.failed[0].error,
          }),
        );
      }
      const text = t(enable ? `${bulkNs}.enabled` : `${bulkNs}.disabled`, {
        count: result.applied.length,
        app: APP_DISPLAY_NAME[app],
      });
      const options = {
        description: notes.length > 0 ? notes.join(" ") : undefined,
        closeButton: true,
      };
      if (notes.length > 0) toast.warning(text, options);
      else toast.success(text, options);
    } catch (bulkError) {
      toast.error(t("projectScope.resyncFailed"), {
        description: String(bulkError),
      });
    }
  };

  const handleForce = async () => {
    if (!conflict) return;
    const { row, app } = conflict;
    setConflict(null);
    try {
      await write(row, app, true, true);
      toast.success(
        t("projectScope.overwritten", {
          name: row.name,
          app: APP_DISPLAY_NAME[app],
        }),
        { closeButton: true },
      );
    } catch (forceError) {
      toast.error(t("projectScope.toggleFailed", { name: row.name }), {
        description: String(forceError),
      });
    }
  };

  const handleResync = async () => {
    try {
      const report = await resync.mutateAsync(projectId);
      if (report.failures.length > 0) {
        toast.warning(
          t("projectScope.resyncPartial", {
            applied: report.applied,
            failed: report.failures.length,
          }),
          {
            description: report.failures
              .map((failure) => `${failure.itemId}: ${failure.error}`)
              .join("; "),
            closeButton: true,
          },
        );
        return;
      }
      toast.success(t("projectScope.resynced", { count: report.applied }), {
        closeButton: true,
      });
    } catch (resyncError) {
      toast.error(t("projectScope.resyncFailed"), {
        description: String(resyncError),
      });
    }
  };

  if (isLoading) {
    return (
      <div className="py-12 text-center text-body text-fg-2">
        {t("common.loading")}
      </div>
    );
  }

  if (isError || !state) {
    return (
      <div className="py-12 text-center text-body text-danger-text">
        {String(error ?? t("common.error"))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3">
        <MatrixSearch
          className="w-[320px] min-w-[180px] shrink"
          value={search}
          onValueChange={setSearch}
          placeholder={t("projectScope.searchPlaceholder")}
          ariaLabel={t("projectScope.searchPlaceholder")}
          status={
            query ? t("appMatrix.found", { count: visibleRows.length }) : ""
          }
        />
        <span className="shrink-0 whitespace-nowrap text-caption tabular-nums text-fg-2">
          {t("projectScope.count", { count: rows.length })}
        </span>
        <Button
          type="button"
          variant="quiet"
          size="regular"
          className="ms-auto"
          disabled={busy}
          onClick={() => void handleResync()}
        >
          <RefreshCw className="h-4 w-4" strokeWidth={2} />
          {t("projectScope.resync")}
        </Button>
      </div>

      <NoticeSlot className="pb-3">
        <Notice tone="neutral" title={t("projectScope.filesNoticeTitle")}>
          {kind === "mcp"
            ? t("projectScope.filesNoticeMcp", {
                claude: state.targets.claudeMcp,
                approval: state.targets.claudeApproval,
                codex: state.targets.codexMcp,
              })
            : t("projectScope.filesNoticeSkills", {
                claude: state.targets.claudeSkills,
                codex: state.targets.codexSkills,
              })}
        </Notice>

        {kind === "mcp" && state.codexTrust !== "trusted" && (
          <Notice tone="warning" title={t("projectScope.codexTrustTitle")}>
            {t("projectScope.codexTrustBody", { path: state.project.path })}
          </Notice>
        )}
      </NoticeSlot>

      {rows.length === 0 ? (
        <div className="py-12 text-center text-body text-fg-2">
          {kind === "mcp"
            ? t("projectScope.emptyMcp")
            : t("projectScope.emptySkills")}
        </div>
      ) : (
        <MatrixColumnHighlight>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex h-9 items-center gap-3 border-b border-border px-1">
              <span className="min-w-0 flex-1 text-caption text-fg-2">
                {kind === "mcp"
                  ? t("projectScope.columnMcp")
                  : t("projectScope.columnSkill")}
              </span>
              {COLUMNS.map((app) => (
                <span
                  key={app}
                  className="flex w-9 shrink-0 justify-center"
                  title={APP_DISPLAY_NAME[app]}
                >
                  <AppGlyph app={app} className="h-4 w-4" />
                </span>
              ))}
            </div>

            {displayRows.map((entry) => {
              if (entry.kind === "folder") {
                const name = entry.folder?.name ?? t(`${folderNs}.unfiled`);
                const Chevron = entry.collapsed ? ChevronRight : ChevronDown;
                return (
                  <div
                    key={`folder:${entry.key}`}
                    data-folder-row={name}
                    className="flex h-9 items-center gap-3 border-b border-border-subtle bg-subtle px-1"
                  >
                    <button
                      type="button"
                      aria-expanded={!entry.collapsed}
                      aria-label={t(
                        entry.collapsed
                          ? `${folderNs}.expandAria`
                          : `${folderNs}.collapseAria`,
                        { name },
                      )}
                      onClick={() => toggleFolder(entry.key)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-control py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Chevron
                        className="h-4 w-4 shrink-0 text-fg-2"
                        strokeWidth={2}
                      />
                      <Folder
                        className="h-4 w-4 shrink-0 text-fg-2"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 truncate text-body font-medium">
                        {name}
                      </span>
                      <span className="shrink-0 text-caption tabular-nums text-fg-2">
                        {entry.items.length}
                      </span>
                    </button>
                    {COLUMNS.map((app) => {
                      const folderState_ = folderBindState(entry.items, app);
                      return (
                        <MatrixCell
                          key={app}
                          app={app}
                          state={FOLDER_CELL_STATE[folderState_]}
                          disabled={busy || entry.items.length === 0}
                          label={t(`projectScope.folderCell.${folderState_}`, {
                            name,
                            app: APP_DISPLAY_NAME[app],
                          })}
                          onClick={() =>
                            void handleFolderToggle(
                              entry.items,
                              app,
                              folderState_ !== "all",
                            )
                          }
                        />
                      );
                    })}
                  </div>
                );
              }
              const row = entry.item;
              return (
                <div
                  key={row.id}
                  className="flex h-11 items-center gap-3 border-b border-border-subtle px-1"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">{row.name}</span>
                    <span className="block truncate text-caption text-fg-2">
                      {row.id}
                    </span>
                  </span>
                  {COLUMNS.map((app) => {
                    const cell = app === "claude" ? row.claude : row.codex;
                    const state_ = cellState(cell);
                    return (
                      <MatrixCell
                        key={app}
                        app={app}
                        state={state_}
                        disabled={busy}
                        label={t(
                          state_ === "on"
                            ? "projectScope.cellBound"
                            : state_ === "inherited"
                              ? "projectScope.cellInherited"
                              : state_ === "fail"
                                ? "projectScope.cellConflict"
                                : "projectScope.cellOff",
                          { name: row.name, app: APP_DISPLAY_NAME[app] },
                        )}
                        onClick={() => void handleToggle(row, app, cell)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </MatrixColumnHighlight>
      )}

      <p className={cn("pt-3 text-caption text-fg-2")}>
        {t("projectScope.legend")}
      </p>

      {/*
       * 两种冲突的影响面差得很远，文案必须分开：
       * - MCP：只替换同名那一条，文件里其他服务器和设置都不动（写入走的是
       *   读-改-写补丁，不是整文件覆盖）
       * - Skill：整个目录替换，里面现有的文件会被删掉
       */}
      <V7ConfirmDialog
        open={conflict !== null}
        // Skill 会删掉现有文件，MCP 会顶掉一条现有定义：都用红色确认键
        danger
        title={t(
          kind === "mcp"
            ? "projectScope.conflictTitleMcp"
            : "projectScope.conflictTitleSkill",
          { key: conflict?.key ?? "", path: conflict?.path ?? "" },
        )}
        body={t(
          kind === "mcp"
            ? "projectScope.conflictBodyMcp"
            : "projectScope.conflictBodySkill",
          { key: conflict?.key ?? "", path: conflict?.path ?? "" },
        )}
        confirmLabel={t("projectScope.conflictConfirm")}
        pending={busy}
        onConfirm={() => void handleForce()}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}
