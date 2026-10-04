# repo-synapse: implementation plan

> On 2026-10-03 the product was renamed **Neurons** (command `neu`). This plan stays as it was written, with the names of the time: `repo-synapse` is now `neu`, `.repo-synapse/` is `.neurons/` and `?src=repo-synapse` is `?src=neurons`. The rename and the compatibility with the old names are in `DECISIONS.md` (I28). What changed in 0.3.0 (bilingual UI, docs routes, Timeline, tool tracking, command detail, now stream, resizable panel, cross-platform work) is in `DECISIONS.md`, from I40 on. `docs/DEMO.md` was removed in 0.3.0: its demo prompts now live in the guide, `docs/guide.html#faq-demo` (a throwaway clone of Neurons) and `#faq-demo-small` (the repo from `scripts/make-demo-repo.sh`), so the `DEMO.md` mentions below (step 13 and the smoke test) point there.

Final plan, written before implementing. It starts from the original idea document and corrects it with what was verified against the official documentation (`code.claude.com/docs/en/hooks`, `hooks-guide`, `settings`) and against the installed binary (`claude 2.1.285`, macOS arm64). The decisions and their reasons are in `DECISIONS.md`.

## 1. What we build

A Node CLI (`repo-synapse`) that, pointed at a repository:

1. Builds the repo tree (`git ls-files --cached --others --exclude-standard`, or a walk with exclusions if it is not git).
2. Starts a server on `127.0.0.1:<port>` that receives Claude Code HTTP hooks, normalizes them into `VizEvent`, stores them in `.repo-synapse/events.jsonl` and broadcasts them over WebSocket.
3. Installs its hooks in `<repo>/.claude/settings.local.json` on startup and removes them on exit.
4. Serves a 3D page (3d-force-graph + bloom) where every file and folder is a node and the light travels root -> folder -> file in the color of the action.

```
Claude Code ──POST /hook (http hook, empty 204)──▶ server 127.0.0.1:7777 ──WS /ws──▶ browser
                                                     ▲        │
                            recursive fs.watch ──────┘        └──▶ .repo-synapse/events.jsonl
```

## 2. Verified facts that shape the design

| Fact | Consequence |
|---|---|
| HTTP hook: 2xx with an empty body = no decision. A plain text body (`OK`) = visible non-blocking error | `POST /hook` answers `204` with no body, before processing. Never JSON with decision fields |
| Server down: every tool event shows `<Event> hook error` in red | The hooks only exist while `start` runs (installed on startup, removed on exit) |
| Server hung: the tool call waits up to `timeout` (default 600 s) | `timeout: 2` on every hook; the handler acks at once |
| `SessionStart` and `Setup` do not accept `type: "http"` | The session is created when the first `session_id` is seen |
| There is no `async` for HTTP hooks | Immediate response; the heavy work happens after `res.end()` |
| SSRF guard: loopback only. `allowedHttpHookUrls` compares the literal host | Fixed URL `http://127.0.0.1:<port>/hook?src=repo-synapse`; `doctor` checks the allowlist and proxies |
| `maxRedirects: 0` | `/hook` is served directly, without normalizing slashes |
| Large payloads (`Read` carries the content in `tool_response`) | No small body limit; all content is dropped during normalization |
| Native macOS build: there are no `Glob`/`Grep` tools; Claude searches with `bfs`/`ugrep`/`grep`/`rg` through Bash | Bash command classifier (search, delete, move). Glob/Grep handlers are kept for compatibility |
| `PostToolUse(Bash).tool_response.bashEditDiff` can list the changed files (`bashEditDiffEnabled`, user settings only) | Exact attribution when present; watcher + windows as fallback. Confirmed in phase 0 |
| `PostToolBatch`, `PostToolUseFailure` (`error`, `is_interrupt`), `InstructionsLoaded` (`file_path`, `memory_type`, `load_reason`, `trigger_file_path`, no `agent_id`) exist | All of them are recorded |
| A subagent is identified by `agent_id` (not by `agent_type`) | Color by `agent_id` |
| Post can arrive in any order with parallel calls; a cancellation fires no Post | Windows per `tool_use_id`, also closed on `Stop`, the next `UserPromptSubmit` and a TTL |
| Do not subscribe to `WorktreeCreate`/`WorktreeRemove`/`PreModelSwitch` | A passive receiver breaks those flows |
| chokidar 5 on macOS opens one fd per file (EMFILE at ~60k) | `fs.watch(root, {recursive: true})` (FSEvents) + classification by `stat` + our own index |
| `emitParticle(link)` needs the live link object and covers a single hop; speed is per frame | `parent->child` map to live links; chained hops with a delay |

## 3. Stack

Node >= 22.12 (tested on 26), TypeScript, ESM. Server with `node:http` + `ws` (no framework). Frontend with Vite + TS, `3d-force-graph` 1.80, `three` 0.186, `force-graph` for the 2D mode. CLI build with `tsdown`, development with `tsx`. Tests with Vitest 5 and Playwright.

## 4. Repo layout

```
src/
  cli.ts                 commands start | install | uninstall | replay | doctor
  shared/types.ts        VizEvent, TreeNode, WS messages
  server/
    server.ts            node:http + ws, routes, ring buffer, broadcast
    tree.ts              initial scan and path index
    paths.ts             relativization, inside/outside the repo
    normalize.ts         hook payload -> VizEvent[]
    bash.ts              Bash command classifier
    attribution.ts       windows per tool_use_id, dedupe, bashEditDiff
    watcher.ts           recursive fs.watch + classification
    eventlog.ts          append to .repo-synapse/events.jsonl
  install/settings.ts    hook merge/unmerge, backup, manifest, exclude
web/                     Vite frontend (index.html, src/*.ts)
scripts/probe/           phase 0 recorder and script
scripts/make-demo-repo.sh
test/unit | test/integration | test/e2e | test/fixtures/payloads
docs/
```

## 5. Event model

```ts
type Action = "read" | "edit" | "create" | "delete" | "move" | "search" | "bash"
  | "context_load" | "subagent_start" | "subagent_stop" | "turn_start" | "turn_end"
  | "session_start" | "session_end" | "batch_end" | "compact" | "tool";

type VizEvent = {
  id: string; ts: number; sessionId: string; promptId?: string;
  agentId?: string; agentType?: string; toolUseId?: string; toolName?: string;
  phase: "pre" | "post" | "fail" | "info";
  action: Action;
  paths: string[];          // relative to the repo, with "/"
  outsideRepo?: string[];   // absolute, outside the repo
  secondary?: string[];     // search results (secondary flash)
  detail?: string;          // pattern, command truncated to 120, load_reason
  source: "hook" | "watcher";
  external?: boolean;       // disk change with no Claude window
};
```

WS messages server -> client: `hello` (root, tree, last 500 events, sessions), `event`, `tree` (`added`, `removed`). Adjusted after phase 0.

## 6. Normalization rules

- `Read` -> `read`. `Edit`, `MultiEdit`, `NotebookEdit` -> `edit`. `Write` -> `create` if the file does not exist at `PreToolUse` (remembered by `tool_use_id`; in Post, `tool_response.type` wins when present).
- `Glob`/`Grep` -> `search` on `tool_input.path` (resolved against `cwd`) or the root; paths from `tool_response` as `secondary`.
- `Bash`: command classification. Search (`grep`, `rg`, `ugrep`, `bfs`, `find`, `fd`, `ls`, `tree`, `ag`) -> `search`; `rm`/`git rm`/`unlink`/`rmdir` -> `delete`; `mv`/`git mv` -> `move`; the rest -> `bash`. Candidate paths: arguments that resolve inside the repo. In Post, `bashEditDiff` produces exact per-file events.
- `Agent`/`Task` -> `tool` with the description; the lifecycle comes from `SubagentStart`/`SubagentStop`.
- `InstructionsLoaded` -> `context_load` on `file_path` (a satellite if it is outside), `detail` = `load_reason`.
- `UserPromptSubmit` -> `turn_start` (prompt truncated to 120). `Stop` -> `turn_end`. `SessionEnd` -> `session_end`. `PostToolBatch` -> `batch_end`. `PreCompact`/`PostCompact` -> `compact`.
- `PostToolUseFailure` -> same action with `phase: "fail"`.
- `content`, `old_string`, `new_string`, raw `tool_response` and diffs are never forwarded or stored.

## 7. Watcher and attribution

- In-memory index from the initial scan. Recursive `fs.watch`; per path, 40 ms coalescing and `lstat` to decide `add`/`addDir`/`change`/`unlink`/`unlinkDir`. An `unlink`+`add` pair within the same window is reported as `move`.
- Exclusions: `.git`, `node_modules`, `.repo-synapse`, `dist`, `build`, plus whatever `git check-ignore` flags (asynchronous query for new paths).
- Windows: `PreToolUse(Bash)` opens a window per `tool_use_id`; `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop` and the next `UserPromptSubmit` close it, with 600 ms of grace for FSEvents latency; 10 minute TTL.
- Disk changes inside a window: a `source: "watcher"` event attributed to that session/agent. Outside every window: `external: true`.
- Dedupe: a disk change on a path with an Edit/Write in progress (or reported by `bashEditDiff` in the last 2 s) produces no new event, but it does update the tree.
- Every creation or deletion emits a `tree` message, whether from Claude or external.

## 8. Hook installation

- File: `<repo>/.claude/settings.local.json`. Events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `InstructionsLoaded`, `Stop`, `StopFailure`, `SessionEnd`, `PreCompact`, `PostCompact`. No `matcher`, `timeout: 2`.
- Own identity: the exact URL ends in `/hook?src=repo-synapse`. Install = remove our own entries and add the new ones (idempotent, fixes old ports). Uninstall = remove only exact matches and clean up arrays and objects we left empty.
- Backup before the first write (`.repo-synapse/settings.local.json.bak`) and a manifest (`.repo-synapse/install.json`) with what was created. If on uninstall the content matches the backup, the original bytes are restored; if the file did not exist, it is deleted.
- Invalid JSON: abort, never overwrite. Atomic write (temp + rename).
- `.claude/settings.local.json` and `.repo-synapse/` are added to `.git/info/exclude` if git does not already ignore them.
- `bashEditDiffEnabled`: only if phase 0 confirms it arrives in the HTTP payload. `start` turns it on in `~/.claude/settings.json` (honoring `CLAUDE_CONFIG_DIR`) if it was off, and reverts it on exit. Several viewers share it: it is reverted when the last one exits (see I15 in `DECISIONS.md`).
- `start` installs on startup and uninstalls on SIGINT/SIGTERM/exit. Lockfile with the PID to keep two processes off the same repo.

## 9. Frontend

- Nodes: root, folders, files; parent -> child links. `d3` layout with `dagMode: "radialout"` and a fixed `dagLevelDistance`, short warmup and cooldown.
- Light: per event, the visible chain root -> ... -> target; `emitParticle` per hop every 80 ms; color, width and speed read from the link at emit time.
- Target node: glow and scale with a 3.5 s decay. Phase `pre` = faint pulse; `post` = full pulse; `fail` = blinking gray.
- Colors: read `#22d3ee`, search `#3b82f6`, edit `#f59e0b`, create `#22c55e`, delete `#ef4444`, move `#f472b6`, context_load `#a855f7`, bash `#e2e8f0`, fail `#6b7280`, external dim gray.
- Subagents: halo hue per `agent_id`.
- Satellites: paths outside the repo grouped under a separate hub (`~/.claude`, `/tmp`, others).
- Structure: `tree` adds nodes (they appear next to their parent) or removes them with a fade; `graphData` updates batched every 150 ms.
- Heatmap: a counter per node; residual glow proportional to `count / max`.
- Collapse: with more than 1,500 visible nodes, folders collapse by depth; a collapsed folder expands on its own when it gets activity.
- Panel: live feed (time, session, agent, action, path), counters per action, filters by session and agent, external toggle, 3D/2D toggle.
- `window.__vizState` exposes nodes, active, created, deleted, fps and feed for the tests.

## 10. Replay

`repo-synapse replay [repo]` serves the same page in replay mode: it loads `events.jsonl`, rebuilds the initial tree and plays it back with play, pause and 1x/2x/5x speed. The live page can also replay the current log.

## 11. Steps (one commit per step)

| # | Step | Verifiable deliverable |
|---|---|---|
| 0 | Scaffold and docs | `package.json`, `tsconfig`, this plan, `DECISIONS.md` |
| 1 | Phase 0: payload probe | `scripts/probe/*`, `docs/PAYLOADS.md`, real fixtures in `test/fixtures/payloads` |
| 2 | Shared types and protocol | `src/shared/types.ts` adjusted to the real payloads |
| 3 | Tree and paths | `tree.ts`, `paths.ts` + tests |
| 4 | Normalizer and Bash classifier | `normalize.ts`, `bash.ts` + one test per tool with fixtures |
| 5 | Watcher and attribution | `watcher.ts`, `attribution.ts` + window and dedupe tests |
| 6 | Server | `server.ts`, `eventlog.ts` + integration (POST -> WS + jsonl) |
| 7 | Installer | `install/settings.ts` + byte for byte merge/unmerge tests |
| 8 | CLI | `start`, `install`, `uninstall`, `replay`, `doctor`, free port, lock |
| 9 | Base graph | 3D scene, bloom, light along the path, colors |
| 10 | Full graph | dynamic tree, satellites, subagents, heatmap, collapse, panel, 2D |
| 11 | Replay | replay mode and controls |
| 12 | E2E and performance | Playwright + measurement with 2,000 files |
| 13 | Demo and README | `make-demo-repo.sh`, `DEMO.md`, README, real smoke test |

## 12. Tests

- Unit: normalizer (real fixtures per tool), create vs edit, relativization, Bash classifier, attribution inside and outside a window, dedupe, installer (keeps other hooks, uninstall restores bytes).
- Integration: real server on a random port; POST of fixtures; checks the empty `204` response, the WS messages, an `events.jsonl` with no file content, and the attribution of a real `rm` against an external delete.
- E2E: Playwright opens the page, injects a sequence through `POST /hook` and checks the feed and `window.__vizState`.
- Performance: synthetic repo with 2,000 files, fps measured in `__vizState`.
- Smoke: real `claude -p` session on the demo repo with the `DEMO.md` script.
- All of it with `npm test`.

## 13. Acceptance criteria and how they are verified

| Criterion | Verification |
|---|---|
| Latency < 300 ms | Integration: receive `ts` vs WS message; E2E: event -> active node |
| Server down with no visible errors | Hooks are removed on exit; uninstall test + `doctor` |
| No file content in the browser or in the jsonl | Integration with payloads that carry `content`, `old_string`, `new_string` and a search for those strings |
| 7 actions + failures + subagents distinguishable | Colors and halos; E2E checks `__vizState` |
| Claude's `rm` = attributed `delete`; external `rm` is not | Integration with a Bash window open vs closed |
| install keeps, uninstall restores | Byte for byte unit tests |
| 2,000 files at 30 fps | Measured in a browser with a GPU, recorded in `DECISIONS.md` |
| `npm test` passes | Local CI (since 0.3.0 also GitHub Actions, `.github/workflows/ci.yml`) |
