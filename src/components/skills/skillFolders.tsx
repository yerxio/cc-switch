import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
} from "lucide-react";
import type { AppId } from "@/lib/api/types";
import type { InstalledSkill } from "@/lib/api/skills";
import type { SkillFolder } from "@/lib/api/skillFolders";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/hover-tip";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { MatrixCell, type MatrixCellState } from "@/components/mcp/AppMatrix";
import { FIELD_CLASS, V7Dialog } from "@/components/mcp/formBits";
import { cn } from "@/lib/utils";

/** 「未分类」这一组在折叠状态里的 key（文件夹用自己的 id） */
export const UNFILED_KEY = "__unfiled__";

/** 文件夹行比 Skill 行矮一截：它是分组标题，不是条目 */
export const FOLDER_ROW_HEIGHT = 40;

export type SkillDisplayRow<T extends { id: string } = InstalledSkill> =
  | {
      kind: "folder";
      /** 文件夹 id，或 [`UNFILED_KEY`] */
      key: string;
      /** `null` = 「未分类」 */
      folder: SkillFolder | null;
      skills: T[];
      collapsed: boolean;
    }
  | { kind: "skill"; key: string; skill: T };

/**
 * 把（已经过搜索 / 筛选的）Skill 列表排成「文件夹行 + 条目行」。
 *
 * 一个文件夹都没有时原样返回扁平列表：没用上这个功能的人看到的界面和以前一样。
 * 有搜索 / 筛选时，没有命中项的文件夹不显示，免得一排空标题。
 */
export function buildSkillDisplayRows<
  T extends { id: string } = InstalledSkill,
>(
  skills: T[],
  folders: SkillFolder[],
  assignments: Record<string, string>,
  collapsed: ReadonlySet<string>,
  narrowed: boolean,
): SkillDisplayRow<T>[] {
  if (folders.length === 0) {
    return skills.map((skill) => ({ kind: "skill", key: skill.id, skill }));
  }

  const known = new Set(folders.map((folder) => folder.id));
  const byFolder = new Map<string, T[]>();
  const unfiled: T[] = [];
  for (const skill of skills) {
    const folderId = assignments[skill.id];
    if (folderId && known.has(folderId)) {
      const list = byFolder.get(folderId);
      if (list) list.push(skill);
      else byFolder.set(folderId, [skill]);
    } else {
      unfiled.push(skill);
    }
  }

  const rows: SkillDisplayRow<T>[] = [];
  const pushGroup = (key: string, folder: SkillFolder | null, members: T[]) => {
    const isCollapsed = collapsed.has(key);
    rows.push({
      kind: "folder",
      key,
      folder,
      skills: members,
      collapsed: isCollapsed,
    });
    if (isCollapsed) return;
    for (const skill of members) {
      rows.push({ kind: "skill", key: skill.id, skill });
    }
  };

  for (const folder of folders) {
    const members = byFolder.get(folder.id) ?? [];
    if (narrowed && members.length === 0) continue;
    pushGroup(folder.id, folder, members);
  }
  if (unfiled.length > 0) pushGroup(UNFILED_KEY, null, unfiled);
  return rows;
}

/** 文件夹在某个应用下的整体状态：全开、部分开、全关 */
export type FolderAppState = "all" | "some" | "none";

export function folderAppState(
  skills: InstalledSkill[],
  app: AppId,
): FolderAppState {
  if (skills.length === 0) return "none";
  const on = skills.filter((skill) => Boolean(skill.apps[app])).length;
  if (on === 0) return "none";
  return on === skills.length ? "all" : "some";
}

const CELL_STATE: Record<FolderAppState, MatrixCellState> = {
  all: "on",
  // 「部分启用」借用淡色虚线勾：有，但不全
  some: "inherited",
  none: "off",
};

/**
 * 文件夹行：折叠开关 + 名字 + 数量，右边是和条目行对齐的应用格子。
 *
 * 格子是三态的，点一下对整个文件夹批量开关——全开时点是全关，否则是把没开的
 * 都开上。这是文件夹真正省事的地方。
 */
export function FolderHeaderRow({
  name,
  skills,
  collapsed,
  first,
  appIds,
  disabled,
  selectedCount,
  onPickAll,
  onToggleCollapsed,
  onCell,
  onRename,
  onExport,
  onDelete,
}: {
  name: string;
  skills: InstalledSkill[];
  collapsed: boolean;
  first: boolean;
  appIds: AppId[];
  disabled: boolean;
  /** 这个文件夹里已被勾选的 Skill 数，决定复选框是全选、半选还是没选 */
  selectedCount: number;
  /** 勾选 / 取消这个文件夹里的全部 Skill（折叠着也算） */
  onPickAll: (select: boolean) => void;
  onToggleCollapsed: () => void;
  onCell: (app: AppId, enable: boolean) => void;
  /** 「未分类」不是真文件夹，不能改名 / 删除，不传这两个 */
  onRename?: () => void;
  onExport: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const allSelected = skills.length > 0 && selectedCount === skills.length;
  return (
    <li
      data-folder-row={name}
      className={cn(
        "group relative flex items-center bg-subtle pe-2",
        !first && "border-t border-border",
      )}
      style={{ height: FOLDER_ROW_HEIGHT }}
    >
      <div className="sticky left-0 z-[1] flex min-w-0 flex-1 items-center self-stretch bg-subtle ps-2">
        {/* 和条目行、表头的复选框在同一列：全选这个文件夹，半选时点一下补齐 */}
        <span className="flex w-6 shrink-0 justify-center">
          <Checkbox
            aria-label={t("skillFolders.selectAllAria", { name })}
            disabled={skills.length === 0}
            checked={
              allSelected ? true : selectedCount > 0 ? "indeterminate" : false
            }
            onCheckedChange={() => onPickAll(!allSelected)}
          />
        </span>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={t(
            collapsed ? "skillFolders.expandAria" : "skillFolders.collapseAria",
            { name },
          )}
          onClick={onToggleCollapsed}
          className="ms-1 flex min-w-0 items-center gap-1.5 rounded-control py-1 pe-2 ps-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="h-4 w-4 shrink-0 text-fg-2" strokeWidth={2} />
          <Folder className="h-4 w-4 shrink-0 text-fg-2" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-body font-medium">{name}</span>
          <span className="shrink-0 text-caption tabular-nums text-fg-2">
            {skills.length}
          </span>
        </button>
      </div>
      <div className="flex shrink-0">
        {appIds.map((app) => {
          const state = folderAppState(skills, app);
          return (
            <MatrixCell
              key={app}
              app={app}
              state={CELL_STATE[state]}
              disabled={disabled || skills.length === 0}
              label={t(`skillFolders.cell.${state}`, {
                name,
                app: APP_DISPLAY_NAME[app],
              })}
              onClick={() => onCell(app, state !== "all")}
            />
          );
        })}
      </div>
      <div className="flex w-10 shrink-0 justify-end">
        <DropdownMenu>
          <HoverTip content={t("common.more")}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="icon-compact"
                aria-label={t("skillFolders.moreAria", { name })}
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
            <DropdownMenuItem
              disabled={skills.length === 0}
              onSelect={onExport}
            >
              {t("skillFolders.exportFolder")}
            </DropdownMenuItem>
            {onRename && (
              <DropdownMenuItem onSelect={onRename}>
                {t("skillFolders.rename")}
              </DropdownMenuItem>
            )}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger-text focus:text-danger-text"
                  onSelect={onDelete}
                >
                  {t("skillFolders.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** 批量栏里的「移动到…」：列出文件夹、「未分类」和「新建文件夹…」 */
export function MoveToFolderMenu({
  folders,
  disabled,
  onPick,
  onCreate,
}: {
  folders: SkillFolder[];
  disabled: boolean;
  onPick: (folderId: string | null) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
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
          {t("skillFolders.moveTo")}
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={t("skillFolders.moveTo")}
        className="max-h-[320px] min-w-[220px] overflow-y-auto"
      >
        {folders.map((folder) => (
          <DropdownMenuItem key={folder.id} onSelect={() => onPick(folder.id)}>
            <Folder className="h-4 w-4" strokeWidth={1.75} />
            <span className="min-w-0 truncate">{folder.name}</span>
          </DropdownMenuItem>
        ))}
        {folders.length > 0 && (
          <>
            <DropdownMenuItem onSelect={() => onPick(null)}>
              {t("skillFolders.moveOut")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={onCreate}>
          <FolderPlus className="h-4 w-4" strokeWidth={1.75} />
          {t("skillFolders.newFolderEllipsis")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 新建 / 重命名共用的取名框 */
export function FolderNameDialog({
  open,
  title,
  confirmLabel,
  initialName,
  pending,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  initialName: string;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(initialName);
  // 每次打开都从传入的名字开始，不留上一次敲到一半的内容
  React.useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const trimmed = name.trim();
  return (
    <V7Dialog
      open={open}
      describedBy={undefined}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && !pending) onSubmit(trimmed);
        }}
      >
        <DialogTitle className="text-section">{title}</DialogTitle>
        <input
          autoFocus
          value={name}
          maxLength={64}
          aria-label={t("skillFolders.nameLabel")}
          placeholder={t("skillFolders.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          className={FIELD_CLASS}
        />
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="neutral"
            size="regular"
            disabled={pending}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="solid"
            size="regular"
            disabled={pending || !trimmed}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </V7Dialog>
  );
}
