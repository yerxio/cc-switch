import * as React from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Notice, NoticeSlot } from "@/components/ui/notice";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import {
  MatrixCell,
  MatrixColumnHighlight,
  MatrixSearch,
  type MatrixCellState,
} from "@/components/mcp/AppMatrix";
import { cn } from "@/lib/utils";
import {
  useProjectScopeState,
  useResyncProjectScope,
  useToggleProjectMcp,
  useToggleProjectSkill,
} from "@/hooks/useProjectScope";
import type {
  ProjectCell,
  ProjectItemState,
  ProjectScopeApp,
} from "@/lib/api/projectScope";

/** 项目级第一版只有这两列 */
const COLUMNS: ProjectScopeApp[] = ["claude", "codex"];

function cellState(cell: ProjectCell): MatrixCellState {
  if (cell.bound) return "on";
  if (cell.foreign) return "fail";
  if (cell.global) return "inherited";
  return "off";
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
  const [search, setSearch] = React.useState("");

  const busy =
    disabled ||
    toggleMcp.isPending ||
    toggleSkill.isPending ||
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

  const foreignHere = (state?.foreign ?? []).filter(
    (entry) => entry.kind === (kind === "mcp" ? "mcp" : "skill"),
  );

  const handleToggle = async (
    row: ProjectItemState,
    app: ProjectScopeApp,
    cell: ProjectCell,
  ) => {
    if (cell.foreign) {
      // 外来同名条目：后端会拒绝，这里先把原因说清楚，省掉一次无意义的失败
      toast.warning(t("projectScope.foreignBlockedTitle", { name: row.name }), {
        description: t("projectScope.foreignBlockedBody"),
        closeButton: true,
      });
      return;
    }
    const enabled = !cell.bound;
    try {
      if (kind === "mcp") {
        await toggleMcp.mutateAsync({
          projectId,
          serverId: row.id,
          app,
          enabled,
        });
      } else {
        await toggleSkill.mutateAsync({
          projectId,
          skillId: row.id,
          app,
          enabled,
        });
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

        {foreignHere.length > 0 && (
          <Notice tone="warning" title={t("projectScope.foreignTitle")}>
            {t("projectScope.foreignBody", {
              list: foreignHere
                .map((entry) =>
                  t("projectScope.foreignItem", {
                    key: entry.key,
                    app: APP_DISPLAY_NAME[entry.app],
                  }),
                )
                .join(t("mcpPage.listSeparator")),
            })}
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

            {visibleRows.map((row) => (
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
                              ? "projectScope.cellForeign"
                              : "projectScope.cellOff",
                        { name: row.name, app: APP_DISPLAY_NAME[app] },
                      )}
                      onClick={() => void handleToggle(row, app, cell)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </MatrixColumnHighlight>
      )}

      <p className={cn("pt-3 text-caption text-fg-2")}>
        {t("projectScope.legend")}
      </p>
    </div>
  );
}
