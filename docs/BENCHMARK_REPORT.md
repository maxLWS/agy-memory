# Empirical Benchmark & Iteration Report (`v0.1.0` → `v0.2.0`)

[English](BENCHMARK_REPORT.md) · [简体中文](BENCHMARK_REPORT.zh-CN.md)

This report documents the real `agy -p` A/B benchmark used to validate **`agy-memory`**, including where **`v0.1.0` genuinely failed or regressed** against baseline, the transcript-level root causes we diagnosed, and the verified before/after gains after iterating to **`v0.2.0`**.

All workspace paths, session IDs, and domain terms have been anonymized.

---

## 1. Benchmark Methodology

To avoid synthetic cherry-picking, every measurement was executed using real headless Antigravity CLI runs (`agy -p --output-format json --dangerously-skip-permissions --print-timeout 180s`):

- **Frozen corpus**: Read-only hardlinked snapshot of **139 real local Antigravity conversations** (70 root sessions + 69 subagent/Swarm worker children; `50+ MB` of `transcript.jsonl`, `~99 MB` of `transcript_full.jsonl`, Markdown artifacts, and multi-worker Swarm boards). Active benchmark/development sessions were excluded from the snapshot for zero data leakage.
- **Strict arm isolation**: Each task ran inside a fresh temporary `HOME` directory backed by the frozen snapshot. Baseline mounted no `agy-memory` plugin (`0` snapshot injections, `0` memory tool calls); Treatment mounted the installed `agy-memory` plugin (`7/7` snapshot injections). Real user databases and `notes.json` were verified byte-unchanged after every round.
- **Single pinned model**: `gemini-3.8-flash-medium` across Baseline, `v0.1.0`, and `v0.2.0` with byte-identical user prompts.
- **Objective programmatic grading**: Every task checked concrete ground-truth assertions (session ID discovery, exact factual findings, artifact names/links, Swarm agent findings, note round-trip persistence, and strict negative non-hallucination).
- **Metric accounting**: Recomputed directly from raw `transcript.jsonl` `PLANNER_RESPONSE` and `GENERIC` steps (`0` discrepancies across all 24 raw runs). Estimated billable equivalent tokens use the conservative formula:
  ```
  est_billable_equiv = uncached_input + 0.1 * cache_read + 5 * output
  ```

### The 7 Task Categories

| ID | Category | What It Tests |
| :---: | :--- | :--- |
| **T1** | CJK + English cross-session lookup | Multi-word bilingual search across transcripts & artifacts without leaking the session ID |
| **T2** | Multi-hop architecture recall | Tracing multiple engineering decisions across a 1,300+ step historical session |
| **T3** | Long Swarm board inspection | Extracting specific worker conclusions and fixes from an 85+ message Swarm board |
| **T4** | Markdown artifact retrieval | Finding and reading a past session's multi-hundred-line `.md` plan with exact references |
| **T5** | Same-workspace recency disambiguation | Identifying the top 4 substantive recent sessions in the current workspace (ignoring noisy probes) |
| **T6** | Cross-session note persistence | Saving a tagged note in Session A and recalling it accurately in a fresh Session B |
| **T7** | Negative / anti-hallucination query | Querying a nonexistent codename — must verify absence cleanly without hallucinating or stalling |

---

## 2. Three-Way Aggregate Results (T1–T7)

| Arm | Pass Rate | Model Time | Wall Time | LLM Turns | Tool Calls (`mem` / `raw`) | Uncached Input | Cache Read | Output | Est. Billable Eq | Payload KB | Disk Spills |
| :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **Baseline (no plugin)** | 7/7 (100%) | 594.4s | 656.9s | 71 | 66 (0 / 57) | 380,045 | 1,606,423 | 31,656 | **698,967** | 123.5 KB | 10 |
| **`agy-memory v0.1.0`** | 6/7 (86%) | 282.6s | 488.7s | 42 | 42 (26 / 13) | 282,756 | 900,442 | 18,049 | **463,045** | 89.4 KB | 5 |
| **`agy-memory v0.2.0`** | **7/7 (100%)** | **213.2s** | **270.4s** | **30** | **35 (31 / 2\*)** | **255,921** | **484,579** | **13,871** | **373,734** | **58.8 KB** | **0** |
| **`v0.2.0` vs. Baseline** | **100%** | **-64.1%** | **-58.8%** | **-57.7%** | **-47.0%** | -32.7% | -69.8% | -56.2% | **-46.5%** | **-52.4%** | **-100%** |
| **`v0.2.0` vs. `v0.1.0`** | **+14.3pp** | **-24.6%** | **-44.7%** | **-28.6%** | **-16.7%** | -9.5% | -46.2% | -23.1% | **-19.3%** | **-34.2%** | **-100%** |

*\*The 2 `raw` calls in `v0.2.0` are intentional direct built-in `read_file` calls on full Markdown artifact paths (T1 & T4). Raw `transcript.jsonl` / SQLite shell fallbacks dropped from **57 (Baseline) → 13 (`v0.1.0`) → 0 (`v0.2.0`)**.*

### Per-Task Progression (`Baseline → v0.1.0 → v0.2.0`)

| Task | Verdict | Model Time (s) | LLM Turns | Raw Shell Calls | Est. Billable Eq | Disk Spills |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** (CJK+EN lookup) | PASS / PASS / PASS | `72.8 → 19.6 → 37.5` | `9 → 3 → 4` | `8 → 0 → 0` | `100.5k → 40.2k → 53.1k` | `1 → 0 → 0` |
| **T2** (Multi-hop recall) | PASS / PASS / PASS | `165.0 → 48.3 → 43.5` | `17 → 9 → 6` | `16 → 0 → 0` | `149.0k → 74.6k → 63.1k` | `2 → 0 → 0` |
| **T3** (Long Swarm board) | PASS / PASS / PASS | `91.1 → 83.3 → 24.3` | `14 → 11 → 3` | `10 → 8 → 0` | `116.1k → 121.3k → 43.4k` | `2 → 3 → 0` |
| **T4** (Artifact retrieval) | PASS / PASS / PASS | `22.8 → 31.1 → 24.9` | `3 → 4 → 3` | `2 → 1 → 0` | `43.8k → 48.7k → 42.9k` | `0 → 0 → 0` |
| **T5** (Workspace recency) | PASS / PASS / PASS | `82.2 → 29.9 → 21.8` | `8 → 3 → 3` | `7 → 0 → 0` | `92.2k → 45.8k → 49.8k` | `2 → 0 → 0` |
| **T6** (Note save + recall) | PASS / PASS / PASS | `117.7 → 29.8 → 34.6` | `15 → 6 → 6` | `12 → 0 → 0` | `141.8k → 69.9k → 71.4k` | `1 → 0 → 0` |
| **T7** (Negative query) | PASS / **FAIL** / **PASS** | `42.9 → 188.0* → 33.4` | `5 → 6 → 5` | `2 → 4 → 0` | `55.5k → 62.5k → 46.1k` | `2 → 2 → 0` |

*\*T7 in `v0.1.0` hit the 180s wall-clock timeout (188.0s total) during a recursive fallback `grep`.*

---

## 3. Three Real `v0.1.0` Failures We Found — And How `v0.2.0` Fixed Them

Running real `agy` sessions instead of toy unit tests immediately exposed three structural defects in `v0.1.0`:

### Defect 1 (P0): Current-Session Self-Matching Caused T7 Timeout (`FAIL → PASS`)
- **What happened in `v0.1.0`**: When the user asked to search for a nonexistent codename, Antigravity had already flushed the current turn's `USER_INPUT` to disk. `search_sessions` returned `1 matching conversation(s): <current_session> [user #0]` — matching **its own prompt**. Confused by the false hit and lacking an authoritative "searched all N past sessions, 0 matched" signal, the agent fell back to 4 slow recursive shell `grep` commands, spilled 2 outputs to disk, and hit the 180s timeout.
- **Root fix in `v0.2.0`**:
  1. `SessionStart` injects `Current session: <shortId> (pass excludeSessionId="<shortId>" when searching past sessions)`.
  2. `excludeSessionId` supports `>=4`-char prefixes and comma-separated IDs.
  3. Even if the caller omits `excludeSessionId`, `search_sessions` automatically skips active in-flight `USER_INPUT` prompts (modified `<180s` ago with no assistant response yet) unless `sessionId` explicitly targets that conversation.
  4. Zero-match responses report exact coverage (`No past conversations matched "..." (searched N session(s) across transcripts, artifacts, and swarm boards)`).
- **Verified result**: T7 recovered from **188.0s TIMEOUT FAIL** to **33.4s PASS (-82% wall time)**, **0 raw shell calls**, **0 disk spills**, and **0.8 KB** total tool payload (**-94%** vs. Baseline).

### Defect 2 (P0): Forward Swarm Truncation Dropped Newest Conclusions in T3 (`-71%` time, `-64%` tokens)
- **What happened in `v0.1.0`**: On an 85-message Swarm board, `read_session(mode="swarm")` formatted messages oldest-to-newest and then clipped at 8,650 bytes — **chopping off the newest `#66–#85` messages** containing the final conclusions. It also lacked `startSeq`/`endSeq`/`query` filters and showed no agent roster when `members.json` was absent. As a result, the agent abandoned MCP after 1 call and ran 8 custom shell scripts (3 disk spills, 11 turns, 83.3s, 121.3k billable tokens — worse than baseline!).
- **Root fix in `v0.2.0`**:
  1. `read_session(mode="swarm")` packs messages **backwards from newest to oldest** inside the 8,650-byte budget so the latest conclusions are never truncated away.
  2. Derives `Board agents` directly from `board.jsonl` when `members.json` is absent.
  3. Adds `startSeq`, `endSeq`, and `query` filters (`tailMessages` up to 100) plus single-session `search_sessions(sessionId=...)`.
- **Verified result**: T3 dropped from **83.3s / 11 turns / 8 shell scripts / 3 spills / 121.3k tokens** down to **24.3s (-71%) / 3 turns (-73%) / 0 shell scripts / 0 spills / 43.4k tokens (-64%)**.

### Defect 3 (P1): Artifact Pagination Overhead & Cold Subprocess Latency
- **What happened in `v0.1.0`**:
  - In T4, `search_sessions(scope="artifacts")` returned a short excerpt without the full filesystem path or line count, forcing an extra MCP pagination turn (`31.1s / 4 turns` vs. Baseline's `22.8s / 3 turns`).
  - Micro-profiling against 139 real sessions showed `python3` spawning on every catalog load (`~30–69 ms` per call) and re-reading 6 MB raw `transcript.jsonl` files (`97.4%` tool-output boilerplate) on every search (`~210 ms`).
- **Root fix in `v0.2.0`**:
  1. Artifact hits expose line count + full `Path`, and `rules/AGENTS.md` instructs the agent to hand off large `.md` files (`>100` lines) directly to built-in `read_file(Path)` (`46 KB` inline, `~7 ms`).
  2. Read-only SQLite uses Node 22.5+ built-in `node:sqlite` (`{ readOnly: true }`) → `sqlite3 -readonly -json` → cross-platform Python → pure-JS fallback, plus in-process catalog caching keyed by `(db, db-wal, brain)` mtime/size and LRU parsed-document caching.
  3. Added automatic `transcript_full.jsonl` hydration for `truncated_fields` plus `charOffset` continuation on >8.2 KB turns.
- **Verified micro-benchmark gains** (139-session frozen snapshot):
  - `SessionStart` hook: `101.5 ms → 44.0 ms`
  - Warm `list_sessions`: `38.2 ms → 1.1 ms`
  - Cold CJK+EN `search_sessions`: `210.4 ms → 59.8 ms` (warm `20.0 ms`)
  - Warm `read_session(digest)` on a 3,456-step (6.3 MB) transcript: `79.5 ms → 7.1 ms`
  - T4 dropped from `31.1s / 4 turns / 8.4 KB` to `24.9s / 3 turns / 4.8 KB`.

---

## 4. Honest Trade-Offs & Break-Even Analysis

- **Fixed prompt overhead**: `rules/AGENTS.md` + 5 eager tool schemas + the `SessionStart` snapshot add **~3,130 input tokens** on turn 1 (`18,093 → 21,223` in our controlled measurement). Because Antigravity caches the static prompt prefix from turn 2 onward, amortized cost per subsequent turn is ~310 equivalent tokens.
- **When it pays off**: Avoiding even **one** exploratory `grep`/`sqlite3` round-trip (`~20k–45k` equivalent tokens and `~10–20s` wall time) pays for the entire session's prompt overhead 6–14× over.
- **When it does not help**: Pure single-session coding tasks that never reference prior conversations or saved notes pay the small turn-1 cached prefix cost without calling memory tools. If you only want `agy-memory` in specific workspaces, install it per-project via `node scripts/install.mjs install --project /path/to/repo`.

---

## 5. `v0.3.0` Measurements & Limits

`v0.3.0` adds file/error history, Markdown topic notes, and read-only Codex/Claude support while keeping 5 eager tools, zero runtime dependencies, and cutting startup metadata (`5 schemas + rules/AGENTS.md`) from `11,022 B` (`v0.2.0`) to `7,668 B` (`-30.4%`).

1. **Core regression (T1–T7, same frozen 139-session snapshot, `n=1`)**: `7/7` pass (`208.7s` model time / `260.7s` wall / `29` turns / `375,011` est. billable vs. `v0.2.0`'s `213.2s` / `270.4s` / `30` turns / `373,734`). An early `v0.3.0` build hit 2 spills on T7; adding an explicit complete-scan line on empty text searches brought T7 back to `0` spills, `4` turns, and `44,846` est. billable (`n=2`).
2. **File write vs. read history (`mode="file_history"`)**: On a task distinguishing which session edited vs. only read a file (`n=1`, candidate IDs supplied), `v0.3.0` finished in `21.6s` / `3` turns / `44.5k` billable / `0` spills, vs. `122.0s` / `14` turns / `158.3k` with trace disabled (`v0.2.0`: `90.0s` / `12` turns; baseline: `113.5s` / `14` turns). A blind check without candidate IDs (`n=2`) also passed `2/2` and routed to `file_history` first (`7` and `23` turns).
3. **Command failure history (`mode="error_history"`, randomized paired `n=5`)**: The first `v0.3.0` build defaulted to `mode="text"` on turn 1 (`4/5` pass, median `78.2s` [range `54.7–190.2s`], `10` turns, `92.1k` billable, `15` total spills). Adding a direct routing hint to `search_sessions.mode` and empty text responses moved the paired runs to `5/5` pass, `5/5` first-turn `error_history`, median `21.6s` [range `18.9–25.7s`], `2` turns, `31.3k` billable [range `29.8k–37.2k`], and `0` spills. A held-out paraphrase with filename (`n=3`) passed `3/3` (median `35.4s`, `4` turns, `0` spills). A vague non-English phrasing without the filename (`n=3`) still tried `error_history` first (`3/3`), but required extra retries when extra Chinese words were mixed into the AND query against English shell logs.
4. **Cross-CLI recall (`source="all"`, frozen real Codex + Claude sessions, `n=1`)**: `v0.3.0` finished in `21.9s` / `3` turns / `39.1k` billable / `0` spills, vs. `56.3s` / `8` turns / `79.5k` (baseline) and `134.9s` / `19` turns / `192.3k` (`v0.2.0`).
5. **Markdown notes (`topics/*.md` + `MEMORY.md`, ~450 B note, `n=1` per variant)**: All 4 storage/snapshot combinations passed, and Markdown did **not** save tokens over flat JSON on small notes. Its practical benefit is human editing, revision-checked writes, and direct `read_file` access for large notes.
6. **Startup prompt tax on an unrelated math task (`T12`, 1 turn, 0 memory calls)**: Turn-1 total input tokens were `18,222` (baseline), `22,129` (`v0.2.0`, `+3,907`), and `21,496` (`v0.3.0`, `+3,274` vs. baseline, `-633` vs. `v0.2.0`).
7. **Large-file streaming in fresh processes**: On a synthetic 55 MB transcript (101k+ steps, target edit at 52 MB), a 32 MB capped scan stopped in `484 ms` with `INCOMPLETE SCAN`, and a second 32 MB call resumed from 32 MB to 55 MB in `355 ms` to find the edit (`VmHWM = 119.5 MB`). A 12 MB file with four 3 MB single lines streamed in `90.5 ms` (`VmHWM = 88.4 MB`).
