import * as React from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Check, FolderOpen, FolderPlus, Globe, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import {
  useAddScopedProject,
  useProjectCandidates,
  useRemoveScopedProject,
} from "@/hooks/useProjectScope";
import type { ScopedProject } from "@/lib/api/projectScope";

/**
 * 作用域切换器：`全局` ↔ `项目`。
 *
 * 选到项目后，面板的矩阵从「12 个工具」收窄为「Claude Code / Codex」两列，行还是
 * 同一批条目——交互不变，变的只是写到哪里。
 *
 * 候选项目有两个来源：手动选目录，以及会话历史里 Claude Code / Codex 用过的工作
 * 目录（白捡的数据，用户不用自己翻路径）。
 */
export function ProjectScopeSelector({
  projects,
  projectId,
  onSelect,
  disabled,
}: {
  projects: ScopedProject[] | undefined;
  projectId: string | null;
  onSelect: (projectId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const addProject = useAddScopedProject();
  const removeProject = useRemoveScopedProject();
  // 扫描会话历史有成本，只在菜单打开过之后才拉
  const [candidatesWanted, setCandidatesWanted] = React.useState(false);
  const { data: candidates } = useProjectCandidates(candidatesWanted);

  const selected = projects?.find((project) => project.id === projectId);
  const busy = disabled || addProject.isPending || removeProject.isPending;

  const handleAdd = async (path: string) => {
    try {
      const project = await addProject.mutateAsync(path);
      onSelect(project.id);
      toast.success(t("projectScope.added", { name: project.name }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("projectScope.addFailed"), { description: String(error) });
    }
  };

  const handlePickDirectory = async () => {
    try {
      const picked = await invoke<string | null>(
        "open_project_directory_dialog",
      );
      if (!picked) return;
      await handleAdd(picked);
    } catch (error) {
      toast.error(t("projectScope.addFailed"), { description: String(error) });
    }
  };

  const handleRemove = async (project: ScopedProject) => {
    try {
      // cleanup=false：只移出受管列表，仓库里已生成的文件原样留下。要连带撤掉
      // 投影，用面板里的「撤销全部并移除」，那是个带确认的破坏性操作。
      await removeProject.mutateAsync({ id: project.id, cleanup: false });
      if (projectId === project.id) onSelect(null);
      toast.success(t("projectScope.removed", { name: project.name }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("projectScope.removeFailed"), {
        description: String(error),
      });
    }
  };

  const unmanagedCandidates = (candidates ?? []).filter(
    (candidate) => !candidate.managed,
  );

  return (
    <div className="flex min-w-0 items-center gap-2">
      <SegmentedControl
        size="sm"
        aria-label={t("projectScope.scopeAriaLabel")}
        value={projectId ? "project" : "global"}
        items={[
          { value: "global", label: t("projectScope.global"), icon: Globe },
          {
            value: "project",
            label: t("projectScope.project"),
            icon: FolderOpen,
            // 还没有受管项目时也允许点：点了直接打开选择器去加一个
            disabled: busy,
          },
        ]}
        onValueChange={(value) => {
          if (value === "global") {
            onSelect(null);
            return;
          }
          if (projects && projects.length > 0) {
            onSelect(projects[0].id);
            return;
          }
          setCandidatesWanted(true);
          setMenuOpen(true);
        }}
      />

      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) setCandidatesWanted(true);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="regular"
            disabled={busy}
            className="min-w-0 max-w-[260px]"
          >
            <FolderOpen className="h-4 w-4 shrink-0" strokeWidth={2} />
            <span className="truncate">
              {selected ? selected.name : t("projectScope.pickProject")}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[420px]">
          {projects && projects.length > 0 && (
            <>
              <DropdownMenuLabel>
                {t("projectScope.managedProjects")}
              </DropdownMenuLabel>
              {projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => onSelect(project.id)}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      project.id === projectId ? "opacity-100" : "opacity-0",
                    )}
                    strokeWidth={2.5}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate",
                        !project.exists && "text-fg-3 line-through",
                      )}
                    >
                      {project.name}
                    </span>
                    <span className="block truncate text-caption text-fg-2">
                      {project.exists
                        ? project.path
                        : t("projectScope.missingPath", { path: project.path })}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="quiet"
                    size="compact"
                    aria-label={t("projectScope.removeProject", {
                      name: project.name,
                    })}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleRemove(project);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                  </Button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          {unmanagedCandidates.length > 0 && (
            <>
              <DropdownMenuLabel>
                {t("projectScope.recentProjects")}
              </DropdownMenuLabel>
              {unmanagedCandidates.slice(0, 8).map((candidate) => (
                <DropdownMenuItem
                  key={candidate.path}
                  onSelect={() => void handleAdd(candidate.path)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{candidate.name}</span>
                    <span className="block truncate text-caption text-fg-2">
                      {candidate.path}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuItem onSelect={() => void handlePickDirectory()}>
            <FolderPlus className="h-4 w-4" strokeWidth={2} />
            {t("projectScope.addProject")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <HelpTip title={t("projectScope.helpTitle")}>
        {t("projectScope.help")}
      </HelpTip>
    </div>
  );
}
