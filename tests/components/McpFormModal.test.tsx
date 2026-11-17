import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/types";
import McpFormModal from "@/components/mcp/McpFormModal";
import { APP_IDS_WITH } from "@/config/appSpecs";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/config/mcpPresets", () => ({
  mcpPresets: [
    {
      id: "preset-stdio",
      name: "Preset Server",
      server: { type: "stdio", command: "preset-cmd", args: ["--x"] },
      homepage: "https://preset.dev",
    },
  ],
  getMcpPresetWithDescription: (preset: any) => ({
    ...preset,
    description: "Preset description",
    tags: ["preset"],
  }),
}));

vi.mock("@/hooks/useMcp", () => ({
  useUpsertMcpServer: () => ({ mutateAsync: mocks.upsert }),
}));

const ALL_OFF = Object.fromEntries(APP_IDS_WITH.mcp.map((app) => [app, false]));

function renderForm(
  props: Partial<React.ComponentProps<typeof McpFormModal>> = {},
) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <McpFormModal
      onSave={onSave}
      onClose={onClose}
      existingServers={{}}
      {...props}
    />,
  );
  return { onSave, onClose };
}

const el = (id: string) => document.getElementById(id) as HTMLInputElement;

const addButton = () => screen.getByRole("button", { name: "common.add" });

describe("McpFormModal (drawer)", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue(undefined);
  });

  it("fills the form from a template", async () => {
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: "preset-stdio" }));
    expect(el("mcp-name")).toHaveValue("preset-stdio");
    expect(el("mcp-cmd")).toHaveValue("preset-cmd");
    expect(screen.getByLabelText("mcpPage.drawer.argAria")).toHaveValue("--x");
  });

  it("adds a stdio server without writing it to any app", async () => {
    const { onSave } = renderForm();
    // 表单里没有「写入到」：写进哪些应用回到列表的矩阵里勾
    expect(screen.queryByText("mcpPage.drawer.writeTo")).toBeNull();
    fireEvent.change(el("mcp-name"), {
      target: { value: "my-server" },
    });
    fireEvent.change(el("mcp-cmd"), {
      target: { value: "uvx" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "mcpPage.drawer.addArg" }),
    );
    fireEvent.change(screen.getByLabelText("mcpPage.drawer.argAria"), {
      target: { value: "mcp-server-fetch" },
    });
    await userEvent.click(addButton());

    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(1));
    const entry = mocks.upsert.mock.calls[0][0] as McpServer;
    expect(entry).toMatchObject({
      id: "my-server",
      name: "my-server",
      server: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    });
    // 只入库：一个应用都没启用
    expect(entry.apps).toMatchObject({ ...ALL_OFF, openclaw: false });
    // 提示里要说明还没写进任何应用，不然人会以为已经生效
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "mcpPage.toast.added",
      expect.objectContaining({ description: "mcpPage.toast.addedHint" }),
    );
    expect(onSave).toHaveBeenCalled();
  });

  it("shows field errors instead of saving when required fields are empty", async () => {
    renderForm();
    await userEvent.click(addButton());
    expect(
      screen.getByText("mcpPage.drawer.errors.nameRequired"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("mcpPage.drawer.errors.commandRequired"),
    ).toBeInTheDocument();
    expect(mocks.upsert).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(el("mcp-name")));
  });

  it("flags a duplicate name as soon as it is typed", () => {
    renderForm({
      existingServers: {
        fetch: {
          id: "fetch",
          name: "fetch",
          server: { command: "uvx" },
          apps: {} as McpServer["apps"],
        },
      },
    });
    fireEvent.change(el("mcp-name"), {
      target: { value: "fetch" },
    });
    expect(
      screen.getByText("mcpPage.drawer.errors.nameExists"),
    ).toBeInTheDocument();
  });

  it("recognizes a pasted mcpServers block and clears the paste box", () => {
    renderForm();
    const paste = screen.getByLabelText("mcpPage.drawer.paste");
    fireEvent.change(paste, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            linear: {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: { Authorization: "Bearer secret" },
            },
          },
        }),
      },
    });
    expect(paste).toHaveValue("");
    expect(el("mcp-name")).toHaveValue("linear");
    expect(el("mcp-url")).toHaveValue("https://mcp.linear.app/mcp");
    // 请求头的值是密码框
    expect(screen.getByLabelText("mcpPage.drawer.kvValueAria")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("adds only new servers from a batch paste and skips existing names", async () => {
    renderForm({
      existingServers: {
        figma: {
          id: "figma",
          name: "figma",
          server: { type: "http", url: "http://127.0.0.1:3845/mcp" },
          apps: { claude: true } as McpServer["apps"],
        },
      },
    });
    fireEvent.change(screen.getByLabelText("mcpPage.drawer.paste"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            linear: { type: "http", url: "https://mcp.linear.app/mcp" },
            figma: { type: "http", url: "http://127.0.0.1:3845/mcp" },
          },
        }),
      },
    });
    expect(screen.getByText("mcpPage.drawer.batchTitle")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "mcpPage.drawer.addMany" }),
    );
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(1));
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({ id: "linear" });
  });

  it("keeps an existing server's app flags when a batch overwrites it", async () => {
    // 添加界面没有「写入到」，表单里的勾选全是没人碰过的 false。批量粘贴覆盖 figma
    // 时不能拿它去盖原值，否则 figma 会在它原本启用的应用里被关掉、从配置里删掉。
    // 这里 figma 原本只在 Hermes 启用（Hermes 还从侧栏隐藏了），都要原样带回。
    renderForm({
      existingServers: {
        figma: {
          id: "figma",
          name: "figma",
          server: { type: "http", url: "http://127.0.0.1:3845/mcp" },
          apps: { claude: false, hermes: true } as McpServer["apps"],
        },
      },
    });
    fireEvent.change(screen.getByLabelText("mcpPage.drawer.paste"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            linear: { type: "http", url: "https://mcp.linear.app/mcp" },
            figma: { type: "http", url: "http://127.0.0.1:3845/v2" },
          },
        }),
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "mcpPage.drawer.batchOverwrite" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "mcpPage.drawer.addManyReplace" }),
    );
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(2));
    const figma = mocks.upsert.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.id === "figma");
    expect(figma.apps).toMatchObject({ claude: false, hermes: true });
    expect(figma.apps.codex).toBeFalsy();
    // 换的是连接定义
    expect(figma.server).toMatchObject({ url: "http://127.0.0.1:3845/v2" });

    // 同一批里新加的 linear：一个应用都不启用
    const linear = mocks.upsert.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.id === "linear");
    expect(linear.apps).toMatchObject({ ...ALL_OFF, openclaw: false });
  });

  it("masks secrets in the JSON tab and keeps them on save", async () => {
    const server: McpServer = {
      id: "serena",
      name: "serena",
      server: {
        type: "stdio",
        command: "uvx",
        env: { TOKEN: "keep-me" },
        startup_timeout_ms: 30000,
      },
      apps: { claude: true, codex: false, hermes: true } as McpServer["apps"],
    };
    renderForm({ editingId: "serena", initialData: server });

    expect(el("mcp-name")).toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    const json = screen.getByLabelText("mcpPage.drawer.jsonLabel");
    expect((json as HTMLTextAreaElement).value).toContain("••••••••");
    expect((json as HTMLTextAreaElement).value).not.toContain("keep-me");

    fireEvent.change(json, {
      target: {
        value: (json as HTMLTextAreaElement).value.replace('"uvx"', '"npx"'),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(1));
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({
      id: "serena",
      server: {
        type: "stdio",
        command: "npx",
        env: { TOKEN: "keep-me" },
        startup_timeout_ms: 30000,
      },
      apps: { claude: true, codex: false, hermes: true },
    });
  });

  it("keeps the form tab disabled while the JSON has a syntax error", async () => {
    renderForm({
      editingId: "x",
      initialData: {
        id: "x",
        name: "x",
        server: { type: "stdio", command: "uvx" },
        apps: {} as McpServer["apps"],
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("mcpPage.drawer.jsonLabel"), {
      target: { value: "{ broken" },
    });
    expect(
      screen.getByRole("button", { name: "mcpPage.drawer.tabForm" }),
    ).toBeDisabled();
  });

  it("has no write-to choice when editing and saves the server's app flags untouched", async () => {
    // 启用哪些应用只在列表的矩阵里勾：表单里不出现，保存时也不能改动
    renderForm({
      editingId: "x",
      initialData: {
        id: "x",
        name: "x",
        server: { type: "stdio", command: "uvx" },
        apps: { claude: false, codex: true, hermes: true } as McpServer["apps"],
      },
    });
    expect(screen.queryByText("mcpPage.drawer.writeTo")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Claude Code/ })).toBeNull();

    fireEvent.change(el("mcp-cmd"), { target: { value: "npx" } });
    await userEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalled());

    const saved = mocks.upsert.mock.calls[0][0] as McpServer;
    expect(saved.server).toMatchObject({ command: "npx" });
    expect(saved.apps).toMatchObject({
      claude: false,
      codex: true,
      hermes: true,
    });
  });

  it("warns when an SSE server is enabled in apps without SSE support", async () => {
    renderForm({
      editingId: "remote",
      initialData: {
        id: "remote",
        name: "remote",
        server: { type: "sse", url: "http://127.0.0.1:60002/sse" },
        apps: { claude: true, codex: true, pi: true } as McpServer["apps"],
      },
    });
    expect(
      screen.getByText("mcpPage.drawer.sseAsHttpTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("mcpPage.drawer.sseRejectedTitle"),
    ).toBeInTheDocument();

    // 改成 HTTP 两条提醒都该消失
    await userEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(
      screen.queryByText("mcpPage.drawer.sseAsHttpTitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("mcpPage.drawer.sseRejectedTitle"),
    ).not.toBeInTheDocument();
  });

  it("does not warn about SSE for apps the server is not enabled in", () => {
    renderForm({
      editingId: "remote",
      initialData: {
        id: "remote",
        name: "remote",
        server: { type: "sse", url: "http://127.0.0.1:60002/sse" },
        // 只在 Claude 启用：Codex / Pi 的 SSE 限制与它无关
        apps: { claude: true } as McpServer["apps"],
      },
    });
    expect(
      screen.queryByText("mcpPage.drawer.sseAsHttpTitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("mcpPage.drawer.sseRejectedTitle"),
    ).not.toBeInTheDocument();
  });

  it("follows the JSON tab when checking for SSE", async () => {
    // SSE 的提醒看的是这个服务器已经在哪些应用里启用
    renderForm({
      editingId: "remote",
      initialData: {
        id: "remote",
        name: "remote",
        server: { type: "stdio", command: "uvx" },
        apps: { claude: true, codex: true } as McpServer["apps"],
      },
    });
    expect(
      screen.queryByText("mcpPage.drawer.sseAsHttpTitle"),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("mcpPage.drawer.jsonLabel"), {
      target: { value: '{"type":"sse","url":"http://127.0.0.1:60002/sse"}' },
    });
    expect(
      screen.getByText("mcpPage.drawer.sseAsHttpTitle"),
    ).toBeInTheDocument();
  });

  it("reports a save failure and keeps the drawer open", async () => {
    mocks.upsert.mockRejectedValueOnce(new Error("disk full"));
    const { onSave } = renderForm();
    fireEvent.change(el("mcp-name"), {
      target: { value: "a" },
    });
    fireEvent.change(el("mcp-cmd"), {
      target: { value: "uvx" },
    });
    await userEvent.click(addButton());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    expect(addButton()).toBeEnabled();
  });
});
