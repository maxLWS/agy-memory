<div align="center">

<img src="assets/logo.svg" alt="agy-memory logo" width="76" height="76" />

# agy-memory

**Local cross-conversation memory MCP plugin for Google Antigravity (`agy`)**

[![CI](https://github.com/maxLWS/agy-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/maxLWS/agy-memory/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/maxLWS/agy-memory?style=flat-square&color=38BDF8)](https://github.com/maxLWS/agy-memory/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-38BDF8?style=flat-square)](package.json)
[![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-0-A78BFA?style=flat-square)](package.json)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-64748B?style=flat-square)](#quick-start)
[![Glama MCP Server](https://glama.ai/mcp/servers/maxLWS/agy-memory/badges/score.svg)](https://glama.ai/mcp/servers/maxLWS/agy-memory)

English · [简体中文](README.zh-CN.md) · [Quick Start](#quick-start) · [Tools](#mcp-tools) · [Benchmarks](#benchmarks) · [Report](docs/BENCHMARK_REPORT.md) · [Security](SECURITY.md)

</div>

---

`agy-memory` is a local, zero-dependency [MCP](https://modelcontextprotocol.io/) plugin for **Google Antigravity** (CLI `agy`, Desktop, and IDE). It lets any session search and inspect your local conversation history without grepping raw JSONL logs, running a vector database, or sending data off-machine:

- Search past Antigravity transcripts (hydrating truncated turns from `transcript_full.jsonl`), Markdown artifacts, and Swarm boards.
- Trace which sessions actually edited vs. only read a file (`mode="file_history"`), or find past command failures and exit codes (`mode="error_history"`).
- Optionally query local **Codex** (`~/.codex`) and **Claude Code** (`~/.claude`) sessions read-only (`source="codex"|"claude"|"all"`).
- Keep cross-session notes as plain Markdown files (`topics/<id>.md` + `MEMORY.md`) with revision checks.

| Model Time | Wall-Clock Time | LLM Turns | Est. Billable Tokens | Disk Spills |
| :---: | :---: | :---: | :---: | :---: |
| **-64.1%** | **-58.8%** | **-57.7%** | **-46.5%** | **10 → 0** |

<p align="center">
  <img src="assets/before-after.svg" alt="Before vs After agy-memory comparison: 14 turns / 91.1s / 2 disk spills reduced to 3 turns / 24.3s / 0 disk spills" width="100%" />
</p>

*Measured with real `agy -p` runs across 7 cross-conversation recall tasks on a frozen 139-session local corpus (`v0.2.0` vs. baseline without plugin, pinned model). Full numbers and `v0.3.0` ablations: [docs/BENCHMARK_REPORT.md](docs/BENCHMARK_REPORT.md).*

## Quick Start

**Requirements:** Node.js >= 20. No `npm install` is needed; pre-built ESM bundles live in `dist/`. `node:sqlite` (Node 22.5+), `sqlite3`, `python3`, and [`rg`](https://github.com/BurntSushi/ripgrep) are used when available, with pure-JS fallbacks if absent.

### Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.ps1 | iex
```

Or paste this into an Antigravity session:

```text
Clone https://github.com/maxLWS/agy-memory.git, run `node scripts/install.mjs install && node scripts/install.mjs doctor` inside it to install and verify the agy-memory plugin, and enable it in agy.
```

<details>
<summary>Manual / project-local install</summary>

```bash
git clone https://github.com/maxLWS/agy-memory.git
cd agy-memory

# Global install (~/.gemini/config/plugins/agy-memory)
node scripts/install.mjs install

# Or install for a single repo (<repo>/.agents/plugins/agy-memory)
node scripts/install.mjs install --project /path/to/repo

# Verify MCP handshake, SessionStart hook, and agy plugin validation
node scripts/install.mjs doctor
```

</details>

Start a new `agy` session after installing.

## Plugin Layout

| Component | File | What It Does |
| :--- | :--- | :--- |
| Manifest | [`plugin.json`](plugin.json) | Antigravity plugin descriptor (`agy plugin validate --strict` clean) |
| MCP Server | [`mcp_config.json`](mcp_config.json) → [`dist/mcp-server.mjs`](dist/mcp-server.mjs) | Single-file stdio JSON-RPC server (JSONL + LSP framing) and `--cli` runner |
| Startup Hook | [`hooks.json`](hooks.json) → [`dist/session-start.mjs`](dist/session-start.mjs) | Injects a read-only snapshot (`<=1.8 KB`): current session ID, 5 recent workspace sessions, and pinned notes |
| Rules | [`rules/AGENTS.md`](rules/AGENTS.md) | Routing rules for mode selection, `SessionStart` reuse, and direct `read_file` on large `.md` files |

## MCP Tools

All 5 tools load eagerly and cap responses at `<=8,650` UTF-8 bytes so outputs stay inline instead of spilling to `output.txt`.

1. **`list_sessions`** — Lists recent sessions from the read-only catalog (`source="agy"` by default; optional `"codex"|"claude"|"all"`). Supports `workspace`, `query`, `minSteps`, `sinceHours`, `excludeSessionId`, and `includeChildren`.
2. **`search_sessions`** — Searches past history in three modes:
   - `mode: "text"` (default): CJK + English keyword, phrase, or regex search over transcripts (`transcript_full.jsonl` hydrated), Markdown artifacts (with file `Path` and line count), Swarm boards, and optional Codex/Claude sessions (`source="all"`).
   - `mode: "file_history"` (`agy`): Shows which sessions edited vs. only read a file (`write_succeeded`, `write_failed`, `write_unverified`, `read`), disambiguates duplicate basenames, and returns exact `#step` numbers.
   - `mode: "error_history"` (`agy`): Finds failed commands/tools, exit codes, subsequent edits in the session, and whether the exact same command + working directory later passed (`PASSED` vs. `UNRESOLVED`). Bounded at 32 MB / 2.5 s per scan with explicit `INCOMPLETE SCAN` notices and partial-progress resumption.
3. **`read_session`** — Reads one session by UUID, `>=4`-char prefix, or qualified ID (`codex:<id>`, `claude:<id>`):
   - `mode: "digest"`: Opening turns, middle milestones, tool-only summaries, and latest conclusions.
   - `mode: "turns"`: Exact step range or tail turns, with `transcript_full.jsonl` hydration and `charOffset` pagination for >8.2 KB turns.
   - `mode: "artifacts"`: Lists artifact paths/line counts or reads packed line ranges.
   - `mode: "swarm"`: Packs messages newest-first so recent conclusions are preserved; supports `startSeq`, `endSeq`, and `query`.
4. **`save_note`** — Creates, updates, or deletes plain Markdown notes under `<appDataDir>/plugin_data/agy-memory/memory/topics/<id>.md` and maintains the managed index block in `MEMORY.md` (legacy `notes.json` migrates on first write/recall). Returns `Revision`; pass `expectedRevision` for safe compare-and-swap updates/deletes.
5. **`recall_notes`** — Filters saved notes by `query`, `workspace` (includes global and parent-workspace notes), or `tag`, returning `Path` and `Revision`.

## CLI Mode

Swarm workers do not mount MCP plugins, so the same bundle runs directly from the shell:

```bash
# List recent sessions (add --source all to include Codex and Claude Code)
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli list --workspace /path/to/repo --min-steps 5
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli list --source all --limit 10

# Search text, file edit history, or past command failures
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search "rate limiter 缓存击穿"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --mode file_history "utils.py"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --mode error_history "pytest"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli search --source all "migration"

# Read a session or Swarm board
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read a1b2c3d4 --mode digest
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read codex:01ab34cd --mode turns --tail 5
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli read a1b2c3d4 --mode swarm --tail 25 --query reviewer

# Save/recall notes and view local usage stats
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli note-save --topic "Cache TTL" --content "Keep mutex TTL at 15s" --tags cache,ops
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli note-recall "TTL"
node ~/.gemini/config/plugins/agy-memory/dist/mcp-server.mjs --cli stats --recent 50
```

## Benchmarks

Run with real `agy -p --output-format json` calls against a frozen 139-session snapshot in isolated per-task `HOME` dirs on a single pinned model (`gemini-3.8-flash-medium`). Details and `v0.3.0` ablations are in [`docs/BENCHMARK_REPORT.md`](docs/BENCHMARK_REPORT.md).

### Core Recall Suite (T1–T7)

| Arm | Pass | Model Time | Wall Time | LLM Turns | Calls (`mem` / `raw`) | Uncached In | Cache Read | Output | Est. Billable\* | Spills |
| :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | :---: |
| Baseline (no plugin) | 7/7 | 594.4s | 656.9s | 71 | 66 (0 / 57) | 380,045 | 1,606,423 | 31,656 | **698,967** | 10 |
| `v0.1.0` | 6/7 | 282.6s | 488.7s | 42 | 42 (26 / 13) | 282,756 | 900,442 | 18,049 | **463,045** | 5 |
| `v0.2.0` | **7/7** | **213.2s** | **270.4s** | **30** | **35 (31 / 2†)** | **255,921** | **484,579** | **13,871** | **373,734** | **0** |
| `v0.3.0` | **7/7** | **208.7s** | **260.7s** | **29** | **30 (26 / 4)** | **250,822** | **493,743** | **14,963** | **375,011** | **0‡** |

*\*`Est. Billable = uncached_input + 0.1 * cache_read + 5 * output`. Startup overhead (`5 schemas + rules/AGENTS.md + SessionStart`) in `v0.3.0` is ~3,274 tokens on Turn 1 (`-633` tokens less than `v0.2.0`), cached from Turn 2 onward.*  
*†The 2 `raw` calls in `v0.2.0` are direct `read_file` reads of `.md` artifact paths.*  
*‡Initial `v0.3.0` hit 2 spills on T7; after adding explicit complete-scan coverage hints, T7 re-verified at `0` spills / 4 turns / `44.8k` est. billable (`n=2`).*

### `v0.3.0` Feature Highlights

- **File edit vs. read trace (`mode="file_history"`)**: `21.6s` / `3` turns / `44.5k` billable / `0` spills vs. `122.0s` / `14` turns / `158.3k` with trace disabled (`n=1`; blind discovery `2/2` pass).
- **Command error trace (`mode="error_history"`, randomized paired `n=5`)**: `5/5` pass, median `21.6s` (`18.9–25.7s`), `2` turns, `31.3k` billable, `0` spills vs. `4/5` pass, median `78.2s` (`54.7–190.2s`), `10` turns, `92.1k` billable, `15` spills before routing hints.
- **Cross-CLI recall (`source="all"`, Codex + Claude)**: `21.9s` / `3` turns / `39.1k` billable / `0` spills vs. `56.3s` / `8` turns (baseline) and `134.9s` / `19` turns (`v0.2.0`).
- **55 MB single-transcript streaming (fresh process)**: 32 MB capped scan finishes in `484 ms` with `INCOMPLETE SCAN`; second call resumes 32 → 55 MB in `355 ms` (`VmHWM = 119.5 MB`).

## Privacy & Compatibility

- **Local only**: Zero network calls. See [`SECURITY.md`](SECURITY.md).
- **Read-only on history**: Never writes to Antigravity's SQLite DBs, `brain/`, `~/.codex`, or `~/.claude`.
- **Coexists with `agy-fast`**: Separate plugin directory, MCP namespace (`agy-memory_memory`), and hook.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
npm run bench:stress
npm run validate
```

## License

[MIT](LICENSE)
