# AGENTS.md

本仓库的工具链**安装在 `D:\Tools` 下，且刻意没有写进系统 / 用户的 PATH** —— 它们只给这个项目用。
所以每次调用都要自己把路径带上（下面有现成的前缀），不要假设 `pnpm`、`cargo`、`node` 在 PATH 上。

## 工具与路径

| 工具 | 版本 | 路径 | 由什么钉死 |
| --- | --- | --- | --- |
| Node.js | 22.12.0 | `D:\Tools\node\node.exe` | `.node-version` |
| pnpm | 10.12.3 | `D:\Tools\pnpm\pnpm.exe` | `package.json` 的 `packageManager` |
| Rust | 1.95.0 | `D:\Tools\rust\cargo\bin\cargo.exe` | `src-tauri/rust-toolchain.toml`（`channel = "1.95"`，含 rustfmt + clippy）|

Rust 用 rustup 以 `--no-modify-path` 装入，两个家目录必须显式给出，否则会落回 `~/.rustup`、`~/.cargo`：

- `RUSTUP_HOME = D:\Tools\rust\rustup`
- `CARGO_HOME  = D:\Tools\rust\cargo`

机器上另有一套全局 Node（`C:\nvm4w\nodejs`，v24）。它**不是**本项目要用的版本，别依赖它。

## 系统侧依赖（已就位，无需安装）

| 依赖 | 状态 |
| --- | --- |
| MSVC C++ 生成工具（Rust 链接器）| `D:\ProgramFiles\MicrosoftVisualStudio\18\Community` |
| WebView2 运行时（Tauri 运行时）| 已安装 |

`link.exe` 不在 PATH 上，但 rustc 会自己通过 vswhere / 注册表找到 MSVC，无需先跑 `vcvarsall`。

## 命令前缀

**前端（PowerShell）**

```powershell
$env:Path = 'D:\Tools\node;D:\Tools\pnpm;' + $env:Path
cd D:\MyProjects\cc-switch
```

**Rust（PowerShell）**

```powershell
$env:RUSTUP_HOME = 'D:\Tools\rust\rustup'
$env:CARGO_HOME  = 'D:\Tools\rust\cargo'
$env:Path = 'D:\Tools\rust\cargo\bin;' + $env:Path
cd D:\MyProjects\cc-switch
```

## 常用命令

```powershell
# 前端
pnpm install --frozen-lockfile
pnpm typecheck                 # tsc --noEmit
pnpm test:unit                 # vitest run
pnpm format:check              # prettier
pnpm vitest run tests/components/UnifiedSkillsPanel.test.tsx   # 单个文件

# Rust（注意 --manifest-path，CI 也这么调）
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test  --manifest-path src-tauri/Cargo.toml --lib
cargo test  --manifest-path src-tauri/Cargo.toml --lib <测试名过滤>

# 整个应用（需要上面两套 env 都设好）
pnpm tauri dev
```

## 已知的既有测试失败（基线）

以下在**干净的 `main`（e580a271）上就失败**，与任何新改动无关。判断自己的改动是否破坏测试时请排除它们。

**前端** —— 基线 `Test Files 2 failed | 317 passed (319)`、`Tests 2 failed | 4134 passed (4136)`：

- `tests/components/CodexOAuthSection.test.tsx > renders account quota in Auth Center`
- `tests/components/ProviderCard.agyModel.test.tsx > ignores the binding where accounts cannot be switched`

**Rust**（`cargo test --lib`）—— 基线 `4805 passed; 4 failed; 16 ignored`：

- `codex_config::tests::resolve_catalog_rejects_symlink_escaping_config_dir`
- `commands::misc::tests::windows_lifecycle_preserves_process_path_priority_and_failure`
- `proxy::error::tests::describe_reqwest_error_keeps_cause_and_drops_url`
- `services::session_usage_grokbuild::tests::symlink_cycle_does_not_cause_stack_overflow`

后两类里的 symlink 用例是**本机环境限制**，不是代码问题：Windows 上建符号链接要管理员权限或开发者模式，否则
`panicked ... symlink: 客户端没有所需的特权。 (os error 1314)`（`ERROR_PRIVILEGE_NOT_HELD`）。
CI 的主 Backend 任务跑在 Linux 上，没有这个限制。想在本机修掉就开「设置 → 系统 → 开发者选项 → 开发人员模式」。

改动后要判断是否引入新失败，**跑基线对比，别靠测试名猜**：

```powershell
git stash push -u -m baseline
try { cargo test --manifest-path src-tauri/Cargo.toml --lib } finally { git stash pop }
```

## 网络

直连可用。若下载 / 安装遇到网络问题，本机有 HTTP 代理：

```powershell
$env:HTTP_PROXY  = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
# 单条 Invoke-WebRequest：-Proxy 'http://127.0.0.1:7890'
# cargo：设 CARGO_HTTP_PROXY，或写进 $env:CARGO_HOME\config.toml 的 [http] proxy
```

## 首次构建的代价

`src-tauri` 的依赖树很大（tauri、bundled SQLite、rquickjs、zstd/brotli、axum/hyper/rustls 等）。
第一次 `cargo test` / `cargo build` 可能要十几分钟并产生数 GB 的 `src-tauri/target`，之后增量很快。
别在超时较短的前台调用里跑首次构建。
