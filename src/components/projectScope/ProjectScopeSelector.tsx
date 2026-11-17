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
  useRemoveScopedProject,
} from "@/hooks/useProjectScope";
import type { ScopedProject } from "@/lib/api/projectScope";

/** 上次停在哪个项目：从「全局」切回「项目」时回到它，而不是总跳到列表第一个 */
const LAST_PROJECT_KEY = "cc-switch:project-scope:last";

function readLastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function rememberLastProject(id: string) {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // 记不住就每次回到第一个，不影响功能
  }
}

/**
 * 作用域切换器：`全局` ↔ `项目`。
 *
 * 全局作用域下只有这个切换器——选哪个项目是「项目」作用域里才有意义的事，
 * 所以项目下拉只在切到「项目」之后才出现。
 *
 * 选到项目后，面板的矩阵从「12 个工具」收窄为「Claude Code / Codex」两列，行还是
 * 同一批条目——交互不变，变的只是写到哪里。
 *
 * 项目只由用户自己选目录加入：不去会话历史里猜，也不碰会话那边的任何东西。
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
  const addProject = useAddScopedProject();
  const removeProject = useRemoveScopedProject();

  const selected = projects?.find((project) => project.id === projectId);
  const busy = disabled || addProject.isPending || removeProject.isPending;

  const select = (id: string) => {
    rememberLastProject(id);
    onSelect(id);
  };

  const handleAdd = async (path: string) => {
    try {
      const project = await addProject.mutateAsync(path);
      select(project.id);
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
      // cleanup=false：只移出受管列表，仓库里已生成的文件原样留下
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

  /** 切到「项目」：回到上次的项目；一个项目都没有就直接让用户选目录 */
  const enterProjectScope = () => {
    if (projects && projects.length > 0) {
      const last = readLastProject();
      const target = projects.find((project) => project.id === last);
      select((target ?? projects[0]).id);
      return;
    }
    // 还没有受管项目：没有可选的，直接弹目录选择；取消就留在全局
    void handlePickDirectory();
  };

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
            disabled: busy,
          },
        ]}
        onValueChange={(value) => {
          if (value === "global") onSelect(null);
          else enterProjectScope();
        }}
      />

      {/* 全局作用域下没有「选哪个项目」这回事，下拉只在项目作用域里出现 */}
      {projectId && (
        <DropdownMenu>
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
                    onSelect={() => select(project.id)}
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
                          : t("projectScope.missingPath", {
                              path: project.path,
                            })}
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

            <DropdownMenuItem onSelect={() => void handlePickDirectory()}>
              <FolderPlus className="h-4 w-4" strokeWidth={2} />
              {t("projectScope.addProject")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <HelpTip title={t("projectScope.helpTitle")}>
        {t("projectScope.help")}
      </HelpTip>
    </div>
  );
}
