import { describe, expect, it } from "vitest";
import {
  buildFolderDisplayRows,
  folderAppState,
  UNFILED_KEY,
} from "@/components/common/folders";
import type { InstalledSkill } from "@/lib/api/skills";
import type { Folder } from "@/lib/api/folders";

const skill = (id: string, apps: Partial<InstalledSkill["apps"]> = {}) =>
  ({
    id,
    name: id,
    directory: id,
    apps: { claude: false, codex: false, ...apps },
    installedAt: 0,
  }) as unknown as InstalledSkill;

const folder = (id: string, name = id): Folder => ({
  id,
  name,
  sortOrder: 0,
});

const shape = (rows: ReturnType<typeof buildFolderDisplayRows>) =>
  rows.map((row) =>
    row.kind === "folder" ? `[${row.key}:${row.items.length}]` : row.key,
  );

describe("buildFolderDisplayRows", () => {
  const skills = [skill("a"), skill("b"), skill("c")];

  it("stays a flat list when no folder exists", () => {
    // 没用上文件夹的人，看到的界面必须和以前一模一样
    expect(
      shape(buildFolderDisplayRows(skills, [], {}, new Set(), false)),
    ).toEqual(["a", "b", "c"]);
  });

  it("groups Skills under their folder and puts the rest under Unfiled last", () => {
    const rows = buildFolderDisplayRows(
      skills,
      [folder("web"), folder("rev")],
      { a: "rev", b: "web" },
      new Set(),
      false,
    );
    expect(shape(rows)).toEqual([
      "[web:1]",
      "b",
      "[rev:1]",
      "a",
      `[${UNFILED_KEY}:1]`,
      "c",
    ]);
  });

  it("keeps a collapsed folder's header and count but hides its Skills", () => {
    const rows = buildFolderDisplayRows(
      skills,
      [folder("web")],
      { a: "web", b: "web" },
      new Set(["web"]),
      false,
    );
    expect(shape(rows)).toEqual(["[web:2]", `[${UNFILED_KEY}:1]`, "c"]);
    expect(rows[0]).toMatchObject({ kind: "folder", collapsed: true });
  });

  it("shows an empty folder normally but drops it while searching or filtering", () => {
    const folders = [folder("empty"), folder("web")];
    const assignments = { a: "web" };
    // 平时：空文件夹也要在，不然刚建的文件夹看不见
    expect(
      shape(
        buildFolderDisplayRows(skills, folders, assignments, new Set(), false),
      ),
    ).toContain("[empty:0]");
    // 搜索 / 筛选时：没有命中项的文件夹不显示，免得一排空标题
    expect(
      shape(
        buildFolderDisplayRows(skills, folders, assignments, new Set(), true),
      ),
    ).not.toContain("[empty:0]");
  });

  it("treats a Skill assigned to a folder that no longer exists as unfiled", () => {
    const rows = buildFolderDisplayRows(
      [skill("a")],
      [folder("web")],
      { a: "deleted-folder" },
      new Set(),
      false,
    );
    expect(shape(rows)).toEqual(["[web:0]", `[${UNFILED_KEY}:1]`, "a"]);
  });
});

describe("folderAppState", () => {
  it("reports all, some or none enabled for an app", () => {
    const members = [
      skill("a", { claude: true, codex: true }),
      skill("b", { claude: true }),
    ];
    expect(folderAppState(members, "claude")).toBe("all");
    expect(folderAppState(members, "codex")).toBe("some");
    expect(folderAppState(members, "gemini")).toBe("none");
    expect(folderAppState([], "claude")).toBe("none");
  });
});
