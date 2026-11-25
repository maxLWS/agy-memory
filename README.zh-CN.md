<div align="center">

<img src="assets/logo.svg" alt="agy-memory logo" width="76" height="76" />

# agy-memory

**面向 Google Antigravity (`agy`) 的零依赖本地跨对话记忆 MCP 插件**

[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-38BDF8?style=flat-square)](package.json)
[![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-0-A78BFA?style=flat-square)](package.json)

[English](README.md) · 简体中文 · [快速安装](#快速安装) · [实测基准](#真实-agy-ab-定量基准) · [核心工具](#5-个-mcp-工具) · [安全与隐私](SECURITY.md) · [更新日志](CHANGELOG.md)

</div>

---

**`agy-memory`** 是一个 **100% 本地运行、零运行时依赖** 的 [MCP](https://modelcontextprotocol.io/) 原生插件，适用于 **Google Antigravity**（CLI `agy`、Desktop 与 IDE）。它让新对话可以快速、低 token 开销地检索和回溯本机历史会话——涵盖对话正文（自动补全被截断的 `transcript_full.jsonl` 长回复）、Markdown Artifacts、Swarm 留言板以及跨会话长期笔记——无需外部向量库、后台 LLM 总结或云端同步。

| 模型耗时 | 总墙钟耗时 | LLM 轮次 | 估算计费 Token | 磁盘溢出 |
| :---: | :---: | :---: | :---: | :---: |
| **-64.1%** | **-58.8%** | **-57.7%** | **-46.5%** | **10 → 0 (-100%)** |

*基于冻结的 139 条本地真实历史会话、7 类跨对话检索任务、固定同一模型进行真实 `agy -p` A/B 实测（`v0.2.0` 对比无插件基线）。*

## 快速安装

**环境要求**：**Node.js >= 20**（无需 `npm install`，仓库 `dist/` 已包含预构建、未压缩、零依赖的单文件 ESM 产物）。可选加速依赖：Node 22.5+ 内置 `node:sqlite`（或 `sqlite3` / `python3`）和 [`ripgrep` (`rg`)](https://github.com/BurntSushi/ripgrep)；即使都未安装也会自动走纯 JS 回退，全平台可用。

### 一键安装

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.sh | sh
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.ps1 | iex
```

### 本地克隆或仅项目级安装

```bash
git clone https://github.com/maxLWS/agy-memory.git
cd agy-memory

# 全局安装（~/.gemini/config/plugins/agy-memory）
node scripts/install.mjs install

# 仅安装到单个仓库（<repo>/.agents/plugins/agy-memory）
node scripts/install.mjs install --project /path/to/repo

# 自检安装状态、MCP 握手、SessionStart 钩子与 agy 严格校验
node scripts/install.mjs doctor
```

安装完成后新开一条 `agy` 对话即可自动生效。

## 插件组成

| 组件 | 文件 | 作用 |
| :--- | :--- | :--- |
| **插件清单** | [`plugin.json`](plugin.json) | Antigravity 原生插件清单（通过 `agy plugin validate --strict` 零警告校验） |
| **MCP Server（Eager）** | [`mcp_config.json`](mcp_config.json) → [`dist/mcp-server.mjs`](dist/mcp-server.mjs) | 零依赖单文件 stdio JSON-RPC 服务（同时兼容 JSONL 与 LSP 帧格式），内置 `--cli` 模式 |
| **`SessionStart` 钩子** | [`hooks.json`](hooks.json) → [`dist/session-start.mjs`](dist/session-start.mjs) | 会话启动时注入 `<=1.8 KB` 只读快照：当前会话短 ID、同工作区最近 5 条实质会话与置顶笔记 |
| **路由规则** | [`rules/AGENTS.md`](rules/AGENTS.md) | 引导模型优先复用开场快照、规范传 `excludeSessionId` / `toolSummary`、大 Artifact 直调 `read_file` |

## 5 个 MCP 工具

全部以 `eager: true` 暴露，且严格执行 `<=8,650` 字节 UTF-8 内联预算裁剪（避免代理对截断），彻底杜绝工具返回溢出到 `output.txt`。

1. **`list_sessions`** — 只读查询历史会话目录（进程内按 SQLite + WAL 的 mtime/size 缓存，热态 `<2 ms`），支持 `workspace`、`query`（支持引号短语）、`minSteps`、`sinceHours`、`excludeSessionId`（支持前缀和多 ID）与 `includeChildren` 过滤。
2. **`search_sessions`** — 跨对话中英文检索（多词 AND、引号短语、正则），一次覆盖用户提问、助手回复（自动回填 `transcript_full.jsonl` 被截断内容）、Markdown Artifacts（返回完整 `Path` 和行数以便直调 `read_file`）和 Swarm 留言板；支持 `sessionId` 单会话内检索、严格 `scope` 隔离、自动跳过当前正在进行的无回复提问、多词覆盖去聚集挑选片段以及时效衰减排序。
3. **`read_session`** — 按完整 UUID 或 `>=4` 位前缀渐进读取单个历史会话：
   - `mode: "digest"`：按时间顺序展示开场目标、中间高信号里程碑、仅工具调用轮次摘要及最新结论。
   - `mode: "turns"`：按步号范围或尾部轮次读原文，自动回填长回复，超 8.2 KB 自动返回 `charOffset` 分页续读。
   - `mode: "artifacts"`：列出 Artifact 路径/行数，或按精确预算打包读取指定行区间。
   - `mode: "swarm"`：按最新消息倒推装入预算（永不截掉最新结论），缺 `members.json` 时自动从 `board.jsonl` 推导成员名单，支持 `startSeq` / `endSeq` / `query` 过滤。
4. **`save_note`** — 原子写入、更新或删除跨会话长期笔记到 `<appDataDir>/plugin_data/agy-memory/notes.json`，不触碰 Antigravity 原生数据库。
5. **`recall_notes`** — 按 `query`（匹配 ID、主题、正文、标签、工作区）、`workspace`（同时保留全局与父工作区笔记）或 `tag` 召回已存笔记。

## 真实 `agy` A/B 定量基准

基于冻结的 139 条本地会话快照，按任务完全隔离 `HOME` 环境，固定同一模型（`gemini-3.8-flash-medium`）与相同提示词，使用真实 `agy -p --output-format json` 执行 7 类跨对话任务（已脱敏）：

- **T1**：中英文混合关键词跨会话事实检索
- **T2**：长对话内的多跳工程决策回溯
- **T3**：85+ 条消息的长 Swarm 协作留言板回溯
- **T4**：历史 Markdown Artifact 定位与完整读取
- **T5**：同工作区近期实质会话消歧
- **T6**：跨会话写入笔记（会话 A）→ 新会话召回（会话 B）
- **T7**：不存在代号的防幻觉负例查询

| 方案 | 通过率 | 模型耗时 | 总墙钟耗时 | LLM 轮次 | 工具调用（记忆/原生） | 未命中缓存输入 | 缓存命中读取 | 输出 Token | 估算计费等效\* | 返回体积 | 磁盘溢出 |
| :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **Baseline（无插件）** | 7/7 (100%) | 594.4s | 656.9s | 71 | 66 (0 / 57) | 380,045 | 1,606,423 | 31,656 | **698,967** | 123.5 KB | 10 |
| **`agy-memory v0.1.0`** | 6/7 (86%) | 282.6s | 488.7s | 42 | 42 (26 / 13) | 282,756 | 900,442 | 18,049 | **463,045** | 89.4 KB | 5 |
| **`agy-memory v0.2.0`** | **7/7 (100%)** | **213.2s** | **270.4s** | **30** | **35 (31 / 2†)** | **255,921** | **484,579** | **13,871** | **373,734** | **58.8 KB** | **0** |
| **`v0.2.0` 对比基线** | **100%** | **-64.1%** | **-58.8%** | **-57.7%** | **-47.0%** | -32.7% | -69.8% | -56.2% | **-46.5%** | **-52.4%** | **-100%** |
| **`v0.2.0` 对比 `v0.1.0`** | **+14.3pp** | **-24.6%** | **-44.7%** | **-28.6%** | **-16.7%** | -9.5% | -46.2% | -23.1% | **-19.3%** | **-34.2%** | **-100%** |

*\*`估算计费等效 = 未命中缓存输入 + 0.1 × 缓存命中 + 5 × 输出`。静态规则 + 5 个工具定义 + 开场快照在首轮增加约 3.1k token（第 2 轮起命中缓存）。*  
*†`v0.2.0` 中的 2 次原生调用是在 T1/T4 拿到 Artifact 路径后直接调用内置 `read_file` 读 Markdown 报告；7 项任务中 0 次退回到 shell 翻 `transcript.jsonl` 或查 SQLite。*

### 本地延迟对比（`v0.1.0` → `v0.2.0`）

- `SessionStart` 开场快照：`101.5 ms → 44.0 ms`
- 热态 `list_sessions`：`38.2 ms → 1.1 ms`
- 冷态中英文 `search_sessions`：`210 ms → 59.8 ms`（热态 `20.0 ms`）
- 3,400+ 步长会话热态 `read_session(digest)`：`79.5 ms → 7.1 ms`

## 命令行模式与离线统计

Swarm worker 不会自动挂载 MCP 插件，可直接调用内置 `--cli` 入口：

```bash
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli list --workspace /path/to/repo --min-steps 5 --limit 10
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search "rate limiter 缓存击穿"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --session a1b2c3d4 "singleflight"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read a1b2c3d4 --mode digest
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read a1b2c3d4 --mode swarm --tail 25 --query reviewer
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli note-save --topic "Cache TTL" --content "Keep mutex TTL at 15s" --tags cache,ops
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli note-recall "TTL"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli stats --recent 50
```

## 隐私与兼容性

- **100% 本地运行、零外联请求**：所有检索、摘要与笔记均在本机完成，不向任何外部服务发送数据，详见 [`SECURITY.md`](SECURITY.md)。
- **严格只读原库**：以只读模式打开 `conversation_summaries.db`（`node:sqlite` `{ readOnly: true }`、`sqlite3 -readonly` 或 Python `?mode=ro`），绝不加写锁或修改原库。
- **与 `agy-fast` 完全兼容并存**：独立插件目录、独立 MCP 命名空间（`agy-memory_memory`）与独立 `SessionStart` 钩子。

## 本地开发与校验

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
