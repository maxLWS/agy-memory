<div align="center">

<img src="assets/logo.svg" alt="agy-memory logo" width="76" height="76" />

# agy-memory

**面向 Google Antigravity (`agy`) 的本地跨对话记忆 MCP 插件**

[![CI](https://github.com/maxLWS/agy-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/maxLWS/agy-memory/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/maxLWS/agy-memory?style=flat-square&color=38BDF8)](https://github.com/maxLWS/agy-memory/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-38BDF8?style=flat-square)](package.json)
[![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-0-A78BFA?style=flat-square)](package.json)
[![支持平台](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-64748B?style=flat-square)](#快速安装)
[![Glama MCP Server](https://glama.ai/mcp/servers/maxLWS/agy-memory/badges/score.svg)](https://glama.ai/mcp/servers/maxLWS/agy-memory)

[English](README.md) · 简体中文 · [快速安装](#快速安装) · [MCP 工具](#mcp-工具) · [实测数据](#实测数据) · [评测报告](docs/BENCHMARK_REPORT.zh-CN.md) · [安全说明](SECURITY.md)

</div>

---

`agy-memory` 是一个零运行时依赖的本地 [MCP](https://modelcontextprotocol.io/) 插件，支持 **Google Antigravity**（CLI `agy`、Desktop 与 IDE）。不用起向量库，也不用把记录发到外部服务，就能让新对话直接检索和回看本机历史会话：

- 检索历史对话正文（自动补全 `transcript_full.jsonl` 被截断的长回复）、Markdown Artifacts 和 Swarm 留言板。
- 查某个文件在哪些会话里被改过或只读过（`mode="file_history"`），或者回查历史命令报错和退出码（`mode="error_history"`）。
- 按需只读检索本机 **Codex**（`~/.codex`）和 **Claude Code**（`~/.claude`）历史会话（`source="codex"|"claude"|"all"`）。
- 用纯 Markdown 文件管理跨会话笔记（`topics/<id>.md` + `MEMORY.md`），带版本修订校验防止覆盖。

| 模型耗时 | 总墙钟耗时 | LLM 轮次 | 估算计费 Token | 磁盘溢出 |
| :---: | :---: | :---: | :---: | :---: |
| **-64.1%** | **-58.8%** | **-57.7%** | **-46.5%** | **10 → 0** |

<p align="center">
  <img src="assets/before-after-zh.svg" alt="agy-memory 真实 agy A/B 对比：14 轮 91.1s 2 次溢盘降至 3 轮 24.3s 0 溢盘" width="100%" />
</p>

*基于冻结的 139 条本地历史会话、7 类跨对话任务、固定同一模型进行真实 `agy -p` 对比实测（`v0.2.0` 对比无插件基线）。完整数据与 `v0.3.0` 实测见 [docs/BENCHMARK_REPORT.zh-CN.md](docs/BENCHMARK_REPORT.zh-CN.md)。*

## 快速安装

**环境要求**：Node.js >= 20，无需 `npm install`（`dist/` 内已放好预构建的单文件 ESM 产物）。本机有 `node:sqlite`（Node 22.5+）、`sqlite3`、`python3` 或 [`rg`](https://github.com/BurntSushi/ripgrep) 时会自动启用加速，没有则自动走纯 JS 回退。

### 一键安装

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.sh | sh
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.ps1 | iex
```

也可以直接把下面这句话发给 Antigravity 让它帮你装：

```text
请将 https://github.com/maxLWS/agy-memory.git 克隆到本地，运行 `node scripts/install.mjs install && node scripts/install.mjs doctor` 安装并验证 agy-memory 插件，然后在 agy 中启用它。
```

<details>
<summary>手动安装 / 单项目安装</summary>

```bash
git clone https://github.com/maxLWS/agy-memory.git
cd agy-memory

# 全局安装（~/.gemini/config/plugins/agy-memory）
node scripts/install.mjs install

# 仅安装到单个项目（<repo>/.agents/plugins/agy-memory）
node scripts/install.mjs install --project /path/to/repo

# 自检 MCP 握手、SessionStart 钩子与 agy 插件校验
node scripts/install.mjs doctor
```

</details>

装完后新开一条 `agy` 对话即可生效。

## 插件结构

| 组件 | 文件 | 作用 |
| :--- | :--- | :--- |
| 插件清单 | [`plugin.json`](plugin.json) | Antigravity 原生插件清单（通过 `agy plugin validate --strict`） |
| MCP 服务 | [`mcp_config.json`](mcp_config.json) → [`dist/mcp-server.mjs`](dist/mcp-server.mjs) | 单文件 stdio JSON-RPC 服务（兼容 JSONL / LSP 帧）与 `--cli` 模式 |
| 启动钩子 | [`hooks.json`](hooks.json) → [`dist/session-start.mjs`](dist/session-start.mjs) | 会话启动时注入 `<=1.8 KB` 只读快照：当前会话 ID、同目录最近 5 条会话与置顶笔记 |
| 路由规则 | [`rules/AGENTS.md`](rules/AGENTS.md) | 引导模式选择、复用开场快照，以及遇到大 `.md` 文件时直调 `read_file` |

## MCP 工具

5 个工具均为 `eager: true`，返回严格限制在 `<=8,650` UTF-8 字节内，避免触发 `output.txt` 落盘溢出。

1. **`list_sessions`** — 列出最近的历史会话目录（默认 `source="agy"`，可选 `"codex"|"claude"|"all"`），支持 `workspace`、`query`、`minSteps`、`sinceHours`、`excludeSessionId` 和 `includeChildren`。
2. **`search_sessions`** — 支持 3 种检索模式：
   - `mode: "text"`（默认）：中英文多词、短语或正则检索，覆盖对话正文（自动回填 `transcript_full.jsonl`）、Markdown Artifacts（附文件路径和行数）、Swarm 留言板，以及可选的 Codex / Claude 会话（`source="all"`）。
   - `mode: "file_history"`（`agy`）：区分哪些会话真正改写了文件、哪些只是读过（`write_succeeded` / `write_failed` / `write_unverified` / `read`），同名不同路径会自动列出来区分，并给出精确 `#step`。
   - `mode: "error_history"`（`agy`）：查历史命令/工具报错、退出码、同会话后续改动，以及相同命令和工作目录后来是否跑通（`PASSED` / `UNRESOLVED`）。单次扫描默认上限 32 MB / 2.5 s，触顶显示 `INCOMPLETE SCAN` 并在后续调用中断点续扫。
3. **`read_session`** — 按完整 UUID、`>=4` 位前缀或带来源前缀的 ID（`codex:<id>`、`claude:<id>`）读单个会话：
   - `mode: "digest"`：按时间顺序展示开场目标、中间关键节点、仅工具轮次摘要和最新结论。
   - `mode: "turns"`：按步号区间或尾部轮次读原文，自动回填长回复，超 8.2 KB 返回 `charOffset` 分页续读。
   - `mode: "artifacts"`：列出 Artifact 路径/行数，或按行区间读取。
   - `mode: "swarm"`：按最新消息倒序装入预算，保证不截掉最新结论；支持 `startSeq`、`endSeq` 和 `query`。
4. **`save_note`** — 把跨会话笔记存为人类可直接编辑的 Markdown 文件（`<appDataDir>/plugin_data/agy-memory/memory/topics/<id>.md`），并维护 `MEMORY.md` 里的索引块（旧 `notes.json` 会在首次读写笔记时自动迁移）。返回 `Revision`，传 `expectedRevision` 会在文件已被修改时拒绝覆盖。
5. **`recall_notes`** — 按 `query`、`workspace`（保留全局和父目录笔记）或 `tag` 召回笔记，附带文件 `Path` 和 `Revision`。

## 命令行模式

Swarm worker 不会挂载 MCP 插件，可以直接调同一个打包文件：

```bash
# 列出最近会话（加 --source all 可同时看 Codex 和 Claude Code）
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli list --workspace /path/to/repo --min-steps 5
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli list --source all --limit 10

# 搜正文、查文件改动记录、查命令报错
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search "rate limiter 缓存击穿"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --mode file_history "utils.py"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --mode error_history "pytest"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --source all "migration"

# 读取会话或 Swarm 留言板
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read a1b2c3d4 --mode digest
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read codex:01ab34cd --mode turns --tail 5
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read a1b2c3d4 --mode swarm --tail 25 --query reviewer

# 读写笔记与离线统计
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli note-save --topic "Cache TTL" --content "Keep mutex TTL at 15s" --tags cache,ops
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli note-recall "TTL"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli stats --recent 50
```

## 实测数据

使用真实 `agy -p --output-format json`，在冻结的 139 条本地会话快照与隔离 `HOME` 中固定同一模型（`gemini-3.8-flash-medium`）测试。逐题拆解与 `v0.3.0` 实测见 [`docs/BENCHMARK_REPORT.zh-CN.md`](docs/BENCHMARK_REPORT.zh-CN.md)。

### 核心检索集（T1–T7）

| 方案 | 通过率 | 模型耗时 | 墙钟耗时 | LLM 轮次 | 工具调用（记忆/原生） | 未命中输入 | 缓存读取 | 输出 | 估算计费\* | 溢盘 |
| :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | :---: |
| Baseline（无插件） | 7/7 | 594.4s | 656.9s | 71 | 66 (0 / 57) | 380,045 | 1,606,423 | 31,656 | **698,967** | 10 |
| `v0.1.0` | 6/7 | 282.6s | 488.7s | 42 | 42 (26 / 13) | 282,756 | 900,442 | 18,049 | **463,045** | 5 |
| `v0.2.0` | **7/7** | **213.2s** | **270.4s** | **30** | **35 (31 / 2†)** | **255,921** | **484,579** | **13,871** | **373,734** | **0** |
| `v0.3.0` | **7/7** | **208.7s** | **260.7s** | **29** | **30 (26 / 4)** | **250,822** | **493,743** | **14,963** | **375,011** | **0‡** |

*\*`估算计费 = 未命中输入 + 0.1 × 缓存读取 + 5 × 输出`。`v0.3.0` 首轮启动开销（5 个 Schema + 规则 + 快照）约 3,274 token（比 `v0.2.0` 少 633 token），第 2 轮起走前缀缓存。*  
*†`v0.2.0` 的 2 次原生调用是对 `.md` Artifact 路径直调 `read_file`。*  
*‡`v0.3.0` 初版在 T7 出现 2 次溢盘，补齐完整扫描提示后复测（`n=2`）恢复为 0 溢盘 / 4 轮 / `44.8k` 估算计费。*

### `v0.3.0` 新增能力实测

- **文件写读核验（`mode="file_history"`）**：`21.6s` / `3` 轮 / `44.5k` 计费 / `0` 溢盘；关闭 trace 能力后退化为 `122.0s` / `14` 轮 / `158.3k`（`n=1`；不给会话 ID 的盲查 `2/2` 通过）。
- **命令报错回溯（`mode="error_history"`，`n=5` 随机配对）**：`5/5` 通过，中位 `21.6s`（`18.9–25.7s`）、`2` 轮、`31.3k` 计费、`0` 溢盘；对比优化路由提示前为 `4/5` 通过、中位 `78.2s`（`54.7–190.2s`）、`10` 轮、`92.1k` 计费、`15` 次溢盘。
- **跨 CLI 检索（`source="all"`，Codex + Claude）**：`21.9s` / `3` 轮 / `39.1k` 计费 / `0` 溢盘，对比无插件基线 `56.3s` / `8` 轮与 `v0.2.0` `134.9s` / `19` 轮。
- **55 MB 单转录流式读取（独立进程）**：默认 32 MB 预算 `484 ms` 返回 `INCOMPLETE SCAN`，第二次同预算从 32 MB 续扫至 55 MB 用时 `355 ms`（峰值内存 `VmHWM = 119.5 MB`）。

## 隐私与兼容性

- **纯本地运行**：零网络请求，详见 [`SECURITY.md`](SECURITY.md)。
- **历史数据只读**：绝不写入 Antigravity 原生 SQLite、`brain/`、`~/.codex` 或 `~/.claude`。
- **与 `agy-fast` 互不冲突**：插件目录、MCP 命名空间（`agy-memory_memory`）和启动钩子完全独立。

## 本地开发

```bash
npm install
npm run typecheck
npm run build
npm test
npm run bench:stress
npm run validate
```

## 协议

[MIT](LICENSE)
