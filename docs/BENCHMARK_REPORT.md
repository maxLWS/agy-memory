# Empirical Benchmark & Iteration Report (`v0.1.0` -> `v0.4.1`)

[English](BENCHMARK_REPORT.md) · [简体中文](BENCHMARK_REPORT.zh-CN.md)

This report tracks every controlled headless `agy -p` benchmark from **`v0.1.0`** through **`v0.4.1`**: where earlier builds failed or regressed against baseline, the transcript-level root causes we fixed, and the verified before/after gains across **150+ real isolated `agy -p` runs** (covering both `gemini-3.8-flash-medium` and `claude-sonnet-5-5-medium`).

All workspace paths, real session IDs, and private project terms are anonymized.

---

## 0. Full Version Trajectory (`Baseline -> v0.1.0 -> v0.2.0 -> v0.3.0 -> v0.4.0 -> v0.4.1`)

| Version | Core Focus | Archive Recall (`T1–T7` V1) | Trace (`file` / `error` / Swarm `F1`) | Blackboard & Isolation (`B1–B5`) | Startup Metadata & Turn-1 Tax |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Baseline (no plugin)** | Raw `agy` (`grep` / `sqlite3`) | `7/7` (`594.4s` model, `699.0k` tok, `10` spills) | `file`: `113.5s` · `error`: `78.2s` · `F1`: Timeout (`125.7s`) | **0/15** (0%) | `0 B` (`9,617` tok baseline on `T12`) |
| **`v0.1.0`** | Initial 5-tool MCP + snapshot | `6/7` (`282.6s` model, `463.0k` tok, `5` spills; `T7` timeout) | Not yet implemented | No `project_id` board | — |
| **`v0.2.0`** | TS bundle, `node:sqlite`, newest-first Swarm, self-match fix | **`7/7`** (`213.2s` model `-64.1%`, `373.7k` `-46.5%`, **`0` spills**) | `file` (no trace): `90.0s` / `12` turns | No `project_id` board | `11,022 B` (`+3,907` tok vs. baseline) |
| **`v0.3.0`** | `file_history`, `error_history`, Markdown notes, Codex/Claude | **`7/7`** (`208.7s` model `-64.9%`, `375.0k`, **`0` spills**) | `file`: **`21.6s`** (`-81%`) · `error`: **`21.6s`** (`-72%`, `0` spills) · `F1`: Timeout (`126.0s`) | `11/15` Gemini, `6/10` Claude (**0/5 dual-project bleed**) | `7,674 B` (`+3,304` tok on `T12`) |
| **`head_1b6aaa02`** | Post-v0.3 expanded tool schemas | Same engine as `v0.3.0` | Same engine as `v0.3.0` | Same as `v0.3.0` | `13,946 B` (`+4,401` tok on `T12`) |
| **`v0.4.0`** | Project Blackboard, `ScopeKey` (`project_id`), 4 tools, cut Codex/Claude | `T1/T7/T9/F2` **4/4** (`T7` `44.7s` / `0` spills, `T9` `16.9s` / `2` turns) | Same trace engine · `F1`: Timeout (`126.5s`, 1,400-char Swarm clip) | **15/15** Gemini (**3/3 zero bleed** on `B4`) | **`7,092 B`** (**`+2,648` tok**, `-656` vs. `v0.3.0`, `-1,753` vs. `HEAD`) |
| **`v0.4.1`** | Unclipped single-message Swarm reads + Windows CI test portability | All archive & trace gains preserved | **`F1`: `50.4s` (-60%), `5` turns (-78%), `63.9k` (-67%), `0` spills** | **15/15** Gemini, **10/10** Claude Sonnet 5.5 (**5/5 zero bleed**) | **`7,092 B`** (`4` tools / `43` params, `58.5 ms` p50 hook) |

*Why `v0.1.0` and `v0.2.0` are not re-run on `B1–B5`*: `v0.1.0` and `v0.2.0` predate `project_id` scoping, `file_history`, `error_history`, and Markdown notes; `v0.3.0` is the strongest pre-redesign baseline for both multi-project isolation and trace recall.

---

## 1. `v0.4.0 -> v0.4.1` Evaluation Methodology (122 Runs)

Every end-to-end measurement ran real headless Antigravity CLI sessions (`agy --model <slug> --output-format json --dangerously-skip-permissions --print-timeout 120s [--project <id>] -p <prompt>`) with strict isolation:

- **Per-run isolated `HOME`**: Each run created a fresh temporary `$HOME` containing only auth tokens, minimal empty `settings.json`, named project stubs (`--project`), and (for archive tasks) a read-only hardlinked snapshot of real local sessions (139-session V1 snapshot for `T1/T7/T9`; 190-session V2 snapshot for fresh tasks `F1/F2`, with active development sessions excluded). Parent `ANTIGRAVITY_*` / `AGY_*` variables were stripped before launching child processes.
- **Frozen comparison arms**: `baseline` (no plugin), `v0.3.0` (frozen git archive), `head_1b6aaa02` (post-v0.3.0 expanded tool schemas), `v0.4.0` (first Project Blackboard release), `v0.4.0_no_hint` (`AGY_MEMORY_SIBLING_HINT=0` ablation), and `v0.4.1` (post-benchmark Swarm truncation fix).
- **Paired randomized seeds & cross-model verification**: Multi-session blackboard and prompt-tax tasks used paired random payloads (`seeds 101, 202, 303`) with shuffled arm execution order per seed. Primary runs used `gemini-3.8-flash-medium` (`n=102`); a second model family (`claude-sonnet-5-5-medium`, `n=20`) verified `B1–B5` without single-model overfitting.
- **Recomputed metrics**: All turns, tool calls, disk spills (`output.txt`), Turn-1 input tokens, and billable equivalent tokens (`uncached_input + 0.1 * cache_read + 5 * output`) were recomputed directly from raw `transcript.jsonl`.

### Task Suite (12 Tasks in `v0.4` Suite)

| Group | IDs | What It Measures |
| :--- | :---: | :--- |
| **Project Blackboard & Isolation** | `B1–B5` | `B1` implicit cross-session continuity (zero cue in Session B); `B2` decision superseding (new replaces old); `B3` handoff completion & deletion; `B4` dual named Projects sharing **one** workspace folder (zero cross-project bleed in answers and raw transcripts); `B5` large `>1.5 KB` board index degradation with deep target fact past char 220 |
| **Fallback & Prompt Tax** | `B6, T12` | `B6` missed-post recovery (fact left only in Session A transcript); `T12` unrelated single-turn math under sibling activity (exact Turn-1 token tax & gratuitous call rate) |
| **Verbatim Archive Recall** | `T1, T7, T9, F1, F2` | `T1` bilingual lookup; `T7` nonexistent-token anti-hallucination; `T9` `error_history` exit-code & path check; `F1` fresh 190-session multi-round Swarm audit recall; `F2` fresh 190-session debugging + `file_history` write-vs-read check |

---

## 2. `v0.4.0 -> v0.4.1` Layer-1 Structural & Latency Results

Measured on a deterministic 60-session dual-project fixture (`scripts/stress-benchmark.mjs`, Node 20, `n=30` cold `SessionStart` spawns) and `tools/list` + `rules/AGENTS.md` byte counts:

| Arm | MCP Tools | Params | `tools/list` JSON | `rules/AGENTS.md` | Total Turn-1 Meta | `dist/mcp-server.mjs` | `SessionStart` Hook |
| :--- | :---: | :---: | ---: | ---: | ---: | ---: | :---: |
| **`v0.2.0`** | 5 | 49 | 5,180 B | 5,842 B | 11,022 B | — | 44.0 ms (V1 fixture) |
| **`v0.3.0`** | 5 | 52 | 5,393 B | 2,281 B | 7,674 B | 181,521 B | 186–226 ms (host tail scan) |
| **`head_1b6aaa02`** | 5 | 52 | 11,665 B | 2,281 B | 13,946 B | 190,337 B | 186–226 ms |
| **`v0.4.1`** | **4** | **43** | 5,731 B | **1,361 B** | **7,092 B** | **168,940 B** | **58.5 ms p50** (range `56.5–79.5 ms`) |

- Production source (`src/*.ts`) shrank from `6,570` lines (`v0.3.0`) to `5,900` lines (`v0.4.1`, net `-670` lines) after deleting Codex/Claude adapters (`~500` LOC), legacy `notes.ts` (`730` LOC), and moving `analytics.ts` (`233` LOC) out of the runtime bundle while adding `scope.ts`, `board.ts`, and `stream.ts`.
- All 12 unit and regression suites (`npm test`) and `agy plugin validate --strict` pass cleanly, including multi-process CAS contention, WAL busy-timeout reads, exact 1,535/1,536/1,537 UTF-8 byte boundary tests, cross-client `project_id` conflict fail-closed checks, dead-PID lock reaping, live-PID lock preservation, and unclipped 3.5 KB single-message Swarm reads.

---

## 3. `v0.4.0 -> v0.4.1` Layer-2 End-to-End Results

### 3.1 Project Blackboard & Isolation (`B1–B5`, `gemini-3.8-flash-medium`, `n=3` paired seeds)

| Task | `baseline` | `v0.3.0` | `v0.4.0 / v0.4.1` | Key Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **`B1` Implicit continuity** | **0/3** (`63.9s`, `9t`, `69.4k`, `11` spills) | 3/3 (`16.7s`, `2t`, `20.8k`, `0` spills) | **3/3 (`11.7s` [10.6–23.8s], `1t`, `0` mem, `15.2k`, `0` spills)** | Board inlined on Turn 0 (`-30%` time, `-27%` billable vs. `v0.3.0`) |
| **`B2` Decision superseding** *(fixed JSON prompt)* | **0/3** (`106.9s`, `21t`, `180.3k`, `19` spills) | 3/3 (`26.5s` [22.5–77.9s], `4t`, `31.6k`, `1` spill) | **3/3 (`53.5s` [40.0–86.2s], `9t`, `59.1k`, `3` spills)** | Flash double-checked sibling sessions after seeing `Activity: 2`; Claude answered in **1 turn / 0 calls / 8.5s** (see §3.2 & §5) |
| **`B3` Handoff deletion** | **0/3** (`120.5s`, `15t`, `114.8k`, `8` spills) | 2/3 (`22.3s`, `4t`, `28.4k`, `0` spills) | **3/3 (`13.9s` [13.4–18.0s], `2t`, `18.7k`, `0` spills)** | `+33pp` pass, `-38%` wall time, `-34%` billable vs. `v0.3.0` |
| **`B4` Dual projects on ONE folder** | **0/3** (`210.8s`, `36t`, `271.0k`, `22` spills) | **0/3** (`26.5s`, `3t`, **100% bleed**) | **3/3 (`30.0s` [28.4–39.6s], `4t`, `38.0k`, `0` spills, 0 bleed)** | `v0.3.0` scoped only by folder path and leaked both projects; `v0.4` isolated `project_id` with zero response or transcript leakage |
| **`B5` Large `>1.5 KB` board** | **0/3** (`126.0s`, `14t`, `94.0k`, `10` spills) | 3/3 (`17.6s`, `3t`, `23.7k`, `0` spills) | **3/3 (`19.8s` [16.4–21.7s], `3t`, `26.5k`, `0` spills)** | Clean key-index degradation above 1,536 B; 0 mid-entry truncation |
| **Total (`B1–B5`, 15 paired runs)** | **0/15 (0%)** | **11/15 (73.3%)** | **15/15 (100%)** | Only `v0.4` solves dual-project isolation and full blackboard lifecycle |

*Methodology note on `B2`*: The initial `B2` prompt asked for "a one-line service launch command" inside an empty temp directory, causing `baseline` (0/3), `v0.3.0` (2/3, 73–129s), and `v0.4.0` (0/3, 126s) to spend 15–26 turns hunting for a nonexistent launch script even though `v0.4.0`'s board had already updated and inlined the new values on Turn 0. Replacing the ambiguous phrase with a JSON output contract (byte-identical across all 3 arms) isolated actual decision superseding.

### 3.2 Cross-Model Verification (`B1–B5`, `claude-sonnet-5-5-medium`, `n=2` paired seeds)

| Task | `v0.3.0` (Claude Sonnet 5.5) | `v0.4.1` (Claude Sonnet 5.5) | Delta |
| :--- | :--- | :--- | :--- |
| **`B1` Implicit continuity** | 2/2 (`9.9s`, `1.5t`, `10.9k`, `in1=19,569`) | **2/2 (`8.6s`, `1.0t`, `0` mem, `8.7k`, `in1=18,779`)** | `-20%` billable, `-790` Turn-1 tok |
| **`B2` Decision superseding** | 2/2 (`12.6s`, `2.0t`, `14.0k`, `in1=19,580`) | **2/2 (`8.5s`, `1.0t`, `0` mem, `8.5k`, `in1=18,718`)** | **`-39%` billable, `-33%` wall, 1-turn hit** |
| **`B3` Handoff deletion** | **0/2 FAIL** (`12.3s`, `2.0t`, `14.5k`) | **2/2 PASS (`12.6s`, `2.0t`, `11.9k`)** | **`+100pp` pass** |
| **`B4` Dual projects on ONE folder** | **0/2 FAIL** (`22.2s`, `2.5t`, `21.8k`, **bleed**) | **2/2 PASS (`16.3s`, `2.0t` total, `0` mem, `17.4k`, 0 bleed)** | **`+100pp` pass, 0 tool calls** |
| **`B5` Large `>1.5 KB` board** | 2/2 (`13.1s`, `2.0t`, `14.2k`, `in1=19,679`) | **2/2 (`12.0s`, `2.0t`, `14.0k`, `in1=18,794`)** | `-885` Turn-1 tok |
| **Total (`B1–B5`, 10 paired runs)** | **6/10 (60%)** | **10/10 (100%, 0 spills)** | Confirms results are not overfit to Gemini |

### 3.3 Turn-1 Prompt Tax & Sibling Hint Ablation (`T12` & `B6`, `gemini-3.8-flash-medium`, `n=3` seeds)

| Arm | `T12` Pass & Gratuitous Calls | `T12` Median Turn-1 Input Tokens | Delta vs. `baseline` | `B6` Missed-Post Pass & Median Wall / Billable |
| :--- | :---: | ---: | ---: | :--- |
| **`baseline`** | 3/3 (`0/3` calls) | 9,617 | — | 3/3 (`47.7s`, `10t`, `59.8k`, `5` spills) |
| **`v0.4.0_no_hint`** | 3/3 (`0/3` calls) | 12,243 | `+2,626` | 3/3 (`19.1s`, `3t`, `24.5k`, `0` spills) |
| **`v0.4.0 / v0.4.1`** | **3/3 (`0/3` calls)** | **12,265** | **`+2,648`** (`-656` vs. `v0.3.0`, `-1,753` vs. `HEAD`) | **3/3 (`19.7s`, `3t`, `24.3k`, `0` spills)** |
| **`v0.3.0`** | 3/3 (`0/3` calls) | 12,921 | `+3,304` | 3/3 (`24.4s`, `3t`, `26.1k`, `0` spills) |
| **`head_1b6aaa02`** | 3/3 (`0/3` calls) | 14,018 | `+4,401` | 3/3 (`15.7s`, `2t`, `21.5k`, `0` spills) |

The 1-line sibling activity hint costs only **`+22` tokens** on Turn 1 and caused **`0/3`** gratuitous searches on unrelated tasks.

### 3.4 Verbatim Archive Recall & Real `v0.4.0 -> v0.4.1` Defect Fix (`T1, T7, T9, F1, F2`)

| Task | `baseline` | `v0.3.0` | `v0.4.0` | `v0.4.1` |
| :--- | :--- | :--- | :--- | :--- |
| **`T1`** (CJK+EN lookup, V1) | PASS (`50.4s`, `9t`, `89.9k`, `1` spill) | PASS (`28.6s`, `4t`, `43.8k`, `0` spills) | PASS (`40.5s`, `5t`, `50.4k`, `0` spills) | Same search engine |
| **`T7`** (Negative query, V1) | FAIL (`126.2s` timeout, `4` spills) | PASS (`54.0s`, `8t`, `64.5k`, `1` spill) | **PASS (`44.7s`, `6t`, `46.9k`, `0` spills)** | Same search engine |
| **`T9`** (`error_history`, V1) | FAIL (`125.9s` timeout, `7` spills) | PASS (`18.7s`, `2t`, `25.5k`, `0` spills) | **PASS (`16.9s`, `2t`, `1` mem, `23.6k`, `0` spills)** | Same trace engine |
| **`F2`** (Debug + `file_history`, V2) | FAIL (`127.9s` timeout, `4` spills) | PASS (`48.2s`, `3t`, `49.1k`, `0` spills) | PASS (`53.0s`, `6t`, `65.9k`, `0` spills) | Same trace engine |
| **`F1`** (Long Swarm audit, V2) | FAIL (`125.7s` timeout, `22t`, `206.1k`, `5` spills) | FAIL (`126.0s` timeout, `11t`, `92.3k`, `1` spill) | FAIL (`126.5s` timeout, `23t`, `196.5k`, `4` spills) | **`50.4s` (-60%), `5t` (-78%), `63.9k` (-67%), `0` raw shell, `0` spills**\* |

#### Root Cause Diagnosed on `F1` (`v0.4.0 -> v0.4.1`)
- **What broke in `v0.3.0` and `v0.4.0`**: `read_session(mode="swarm")` in `src/store.ts` hardcoded `bodyClipLen = candidateSlice.length <= 4 ? 1400 : ...`, clipping even single-message reads (`startSeq=79, endSeq=79`) at 1,400 chars while printing *"Pass startSeq/endSeq to inspect specific messages without truncation."* Because the real 3,500-char Swarm audit conclusions placed key file names and final metrics past char 1,400, agents abandoned MCP and ran 11–22 shell commands until hitting the 120s timeout.
- **Root fix in `v0.4.1`**: Single-message Swarm slices now use the full remaining inline budget (~7,500 chars, strictly `<= 8,650` UTF-8 bytes), 2–4 message slices scale dynamically across the budget, and wider slices print exact `pass startSeq=N endSeq=N for full message` hints on clipped entries.
- **\*Grading transparency on `F1`**: `v0.4.1` answered every item asked in `F1` verbatim (27 truncated responses, all 5 parser-truncation fix files/functions, Live `20.0% -> 0.0%`, Replay `Δ_CF = 30.0%`) in 50.4s with 0 spills. The original automated regex check #3 checked an unrelated P0-B filename not asked by Q1, logging 4/5 auto-checks while human verification confirmed 5/5 factual accuracy on Q1 & Q2.

---

## 4. Complete Historical Ledger (`v0.1.0 -> v0.2.0 -> v0.3.0`)

All archive-engine capabilities measured below remain active in `v0.4.1` (only Codex/Claude adapters and the redundant global-lock notes store were removed in `v0.4.0`).

### 4.1 `Baseline -> v0.1.0 -> v0.2.0 -> v0.3.0` Aggregate Results (`T1–T7`, frozen 139-session V1 corpus, `gemini-3.8-flash-medium`)

| Arm | Pass Rate | Model Time | Wall Time | LLM Turns | Tool Calls (`mem` / `raw`) | Uncached Input | Cache Read | Output | Est. Billable Eq | Payload KB | Disk Spills |
| :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **Baseline (no plugin)** | 7/7 (100%) | 594.4s | 656.9s | 71 | 66 (0 / 57) | 380,045 | 1,606,423 | 31,656 | **698,967** | 123.5 KB | 10 |
| **`agy-memory v0.1.0`** | 6/7 (86%) | 282.6s | 488.7s | 42 | 42 (26 / 13) | 282,756 | 900,442 | 18,049 | **463,045** | 89.4 KB | 5 |
| **`agy-memory v0.2.0`** | **7/7 (100%)** | **213.2s** | **270.4s** | **30** | **35 (31 / 2\*)** | **255,921** | **484,579** | **13,871** | **373,734** | **58.8 KB** | **0** |
| **`agy-memory v0.3.0`** | **7/7 (100%)** | **208.7s** | **260.7s** | **29** | — | — | — | — | **375,011** | — | **0** |
| **`v0.2.0` vs. Baseline** | **100%** | **-64.1%** | **-58.8%** | **-57.7%** | **-47.0%** | -32.7% | -69.8% | -56.2% | **-46.5%** | **-52.4%** | **-100%** |

*\*The 2 `raw` calls in `v0.2.0` were intentional built-in `read_file` handoffs on full Markdown artifact paths (T1 & T4). Raw `transcript.jsonl` / SQLite shell fallbacks dropped from **57 (Baseline) -> 13 (`v0.1.0`) -> 0 (`v0.2.0`)**.*

### 4.2 Per-Task Progression (`T1–T7`: `Baseline -> v0.1.0 -> v0.2.0`)

| Task | Verdict | Model Time (s) | LLM Turns | Raw Shell Calls | Est. Billable Eq | Disk Spills |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** (CJK+EN lookup) | PASS / PASS / PASS | `72.8 -> 19.6 -> 37.5` | `9 -> 3 -> 4` | `8 -> 0 -> 0` | `100.5k -> 40.2k -> 53.1k` | `1 -> 0 -> 0` |
| **T2** (Multi-hop recall) | PASS / PASS / PASS | `165.0 -> 48.3 -> 43.5` | `17 -> 9 -> 6` | `16 -> 0 -> 0` | `149.0k -> 74.6k -> 63.1k` | `2 -> 0 -> 0` |
| **T3** (Long Swarm board) | PASS / PASS / PASS | `91.1 -> 83.3 -> 24.3` | `14 -> 11 -> 3` | `10 -> 8 -> 0` | `116.1k -> 121.3k -> 43.4k` | `2 -> 3 -> 0` |
| **T4** (Artifact retrieval) | PASS / PASS / PASS | `22.8 -> 31.1 -> 24.9` | `3 -> 4 -> 3` | `2 -> 1 -> 0` | `43.8k -> 48.7k -> 42.9k` | `0 -> 0 -> 0` |
| **T5** (Workspace recency) | PASS / PASS / PASS | `82.2 -> 29.9 -> 21.8` | `8 -> 3 -> 3` | `7 -> 0 -> 0` | `92.2k -> 45.8k -> 49.8k` | `2 -> 0 -> 0` |
| **T6** (Note save + recall) | PASS / PASS / PASS | `117.7 -> 29.8 -> 34.6` | `15 -> 6 -> 6` | `12 -> 0 -> 0` | `141.8k -> 69.9k -> 71.4k` | `1 -> 0 -> 0` |
| **T7** (Negative query) | PASS / **FAIL** / **PASS** | `42.9 -> 188.0* -> 33.4` | `5 -> 6 -> 5` | `2 -> 4 -> 0` | `55.5k -> 62.5k -> 46.1k` | `2 -> 2 -> 0` |

*\*T7 in `v0.1.0` hit the 180s wall-clock timeout (188.0s total) after matching its own in-flight prompt and falling back to recursive `grep`.*

### 4.3 Three `v0.1.0 -> v0.2.0` Defects Fixed & `v0.3.0` Trace / Streaming Measurements

1. **`v0.1.0 -> v0.2.0` Defect 1 (Self-match timeout on `T7`)**: Skipping active in-flight `USER_INPUT` prompts (`<180s` with no assistant reply) and reporting exact searched session counts recovered `T7` from `188.0s FAIL` to `33.4s PASS (-82%)`, `0` shell calls, and `0` spills.
2. **`v0.1.0 -> v0.2.0` Defect 2 (Forward Swarm clipping on `T3`)**: Packing Swarm messages backwards from newest to oldest and adding `startSeq`/`endSeq`/`query` cut `T3` from `83.3s / 11 turns / 8 shell scripts / 3 spills / 121.3k` down to `24.3s (-71%) / 3 turns (-73%) / 0 spills / 43.4k (-64%)`.
3. **`v0.1.0 -> v0.2.0` Defect 3 (Artifact handoff & SQLite latency)**: Exposing full artifact `Path` for direct `read_file` and adding `node:sqlite` + mtime/LRU caching cut cold CJK+EN search from `210.4 ms` to `59.8 ms` (warm `20.0 ms`) and 3,456-step digest reads from `79.5 ms` to `7.1 ms`.
4. **`v0.3.0` File write vs. read (`mode="file_history"`)**: On a task distinguishing which session edited vs. only read a file (`n=1`, candidate IDs supplied), `v0.3.0` finished in **`21.6s` / `3` turns / `44.5k` billable / `0` spills**, vs. `122.0s` / `14` turns / `158.3k` with trace disabled (`v0.2.0`: `90.0s` / `12` turns; baseline: `113.5s` / `14` turns). Blind checks without candidate IDs passed `2/2` and routed to `file_history` first.
5. **`v0.3.0` Command failure history (`mode="error_history"`, paired `n=5`)**: After adding direct routing guidance to `search_sessions.mode`, paired runs moved from `4/5` (median `78.2s` [54.7–190.2s], `10` turns, `92.1k`, `15` spills) to **`5/5` pass, `5/5` first-turn `error_history`, median `21.6s` [18.9–25.7s], `2` turns, `31.3k` [29.8k–37.2k], `0` spills**. Held-out paraphrases with filename passed `3/3` (median `35.4s`, `4` turns, `0` spills).
6. **`v0.3.0` Large-file streaming (fresh processes, retained in `src/stream.ts` in `v0.4.1`)**: On a synthetic 55 MB transcript (101k+ steps, target edit at 52 MB), a 32 MB capped scan stopped in `484 ms` with `INCOMPLETE SCAN`, and a second call resumed 32 -> 55 MB in `355 ms` to find the edit (`VmHWM = 119.5 MB`). A 12 MB file with four 3 MB lines streamed in `90.5 ms` (`VmHWM = 88.4 MB`).
7. **`v0.3.0` Historical `T12` prompt tax & Markdown note check**: On the earlier `v0.2 -> v0.3` prompt frame (`18,222` baseline tokens), `v0.2.0` added `+3,907` (`22,129`) and `v0.3.0` added `+3,274` (`21,496`, `-633` vs. `v0.2.0`). On ~450 B small notes (`n=1` per variant), Markdown did not save tokens over flat JSON; its value was human editing and revision-checked writes, which carried forward into the `v0.4` Project Blackboard while removing the redundant `MEMORY.md` index and global lock.

---

## 5. Honest Trade-Offs & Known Limits

1. **No background LLM summarization**: `agy-memory` stays strictly offline and zero-cost. If Session A makes a decision without calling `board_post`, Session B falls back to the 1-line sibling hint and `search_sessions(conversationId=...)` (verified on `B6`: 3/3 pass in `19.7s`).
2. **Model-dependent verification conservatism (`B2`)**: When a session sees both an updated inline board entry and `Activity: 2 other active or recent session(s)`, `claude-sonnet-5-5-medium` immediately trusted the board (`1` turn, `0` calls, `8.5s`), whereas `gemini-3.8-flash-medium` spent extra turns double-checking sibling transcripts (`9` turns median, still `3/3` pass). Users who prefer zero sibling hints can set `AGY_MEMORY_SIBLING_HINT=0`.
3. **Turn-1 fixed prompt cost**: Even after cutting `-656` tokens vs. `v0.3.0` and `-1,753` vs. `head_1b6aaa02`, mounting 4 eager MCP tools + `rules/AGENTS.md` adds `~2,648` Turn-1 input tokens on Gemini (`~19%` lower than `v0.3.0`, `~32%` lower than `v0.2.0`). For strictly one-off single-session workspaces, install per-project via `node scripts/install.mjs install --project /path/to/repo`.
