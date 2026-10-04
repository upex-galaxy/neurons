# Real payloads (phase 0)

Captured on 2026-09-30 with **Claude Code 2.1.285** (native build, macOS arm64), headless `claude -p` sessions with `claude-sonnet-5-5`, against a throwaway repo with `CLAUDE.md`, `src/CLAUDE.md` and `.claude/rules/api.md` (with `paths: src/api/**/*.ts`). The Skill and MCP payloads were captured later with Claude Code 2.1.288 (see the last section).

Tools: `scripts/probe/recorder.mjs` (a server that answers an empty `204` and stores every POST), `scripts/probe/make-settings.mjs` (generates the hooks) and `scripts/probe/extract-fixtures.mjs` (replaces the repo root with `__REPO__` and the home folder with `__HOME__`).

Fixtures: `test/fixtures/payloads/run1.jsonl` (39 events: search, reads, edit, create, `rm`, `git mv`, a failed command, a subagent), `run3.jsonl` (`rm` and `echo >` with `bashEditDiffEnabled`) and `run-skill-mcp.jsonl` (10 events: a `Skill` call and an MCP call).

## Transport

- Headers: `content-type: application/json`, `user-agent: axios/1.15.2`, `connection: keep-alive`. The `?src=...` query of the URL arrives intact.
- The debug log confirms: `HTTP hook response status 204, body length 0` -> `HTTP hook returned empty body, treating as empty JSON object`.
- Every POST took about 1 ms round trip on loopback.
- Hooks declared in `<repo>/.claude/settings.local.json` run in `-p` mode (run 2), so the chosen install path works.

## Fields per event

| Event | Observed fields |
|---|---|
| `InstructionsLoaded` | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `file_path`, `memory_type`, `load_reason`, `trigger_file_path`? |
| `UserPromptSubmit` | common + `permission_mode`, `prompt_id`, `prompt` |
| `PreToolUse` | common + `permission_mode`, `prompt_id`, `effort`, `tool_name`, `tool_input`, `tool_use_id`, and `agent_id`/`agent_type` inside a subagent; `mcp_server` for MCP tools |
| `PostToolUse` | the `PreToolUse` fields + `tool_response`, `duration_ms` |
| `PostToolUseFailure` | the `PreToolUse` fields + `error` (text, e.g. `Exit code 1\ncat: ...`), `is_interrupt`, `duration_ms` |
| `PostToolBatch` | common + `tool_calls[]` with `tool_name`, `tool_input`, `tool_use_id`, `tool_response` |
| `SubagentStart` | common + `prompt_id`, `agent_id`, `agent_type` |
| `SubagentStop` | common + `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| `Stop` | common + `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| `SessionEnd` | common + `prompt_id`, `reason` (`other` in `-p`) |

`prompt_id` is missing before the first prompt (`InstructionsLoaded` from `session_start`). `permission_mode` and `effort` are missing in some events. The normalizer treats everything as optional except `session_id` and `hook_event_name`.

## `tool_input` and `tool_response` per tool

| Tool | `tool_input` | `tool_response` (keys) |
|---|---|---|
| `Read` | `file_path` (absolute) | `type: "text"`, `file: {filePath, content, numLines, startLine, totalLines}` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` | `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified`, `replaceAll` |
| `Write` | `file_path`, `content` | `type: "create"` or `"update"`, `filePath`, `content`, `structuredPatch`, `originalFile`, `userModified` |
| `Bash` | `command`, `description` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`, and `bashEditDiff` when enabled |
| `Agent` | `description`, `prompt`, `subagent_type` | `status`, `agentId` (equal to the `agent_id` of the subagent's hooks), `agentType`, `content`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage`, `toolStats`, ... |
| `Skill` | `skill` | `success`, `commandName` |
| `mcp__<server>__<tool>` | the MCP tool's own arguments | an array of content blocks `{type, text}` |

Almost every response carries file content (`content`, `originalFile`, `structuredPatch`, `hunks`, `stdout`). The normalizer reads only paths and metadata.

## Searches

Request "find all the `.ts` files and search for `TODO`": Claude ran **a single Bash** `find . -name "*.ts" ...; grep -rn "TODO" . ...`. No `Glob` or `Grep` tools showed up (they do not exist in this build). `stdout` carries paths (`./src/api/user.ts`) and `path:line:text` lines; paths are extracted from there for the secondary flash, without forwarding the text.

## `bashEditDiff`

It shows up in `PostToolUse(Bash).tool_response` **only** if `bashEditDiffEnabled: true` is in the user settings (`~/.claude/settings.json`) or in `--settings`. In `.claude/settings.local.json` it is ignored (run 2).

```json
{
  "files": [
    { "filePath": "/abs/docs/notes.md", "hunks": [ ... ], "created": true },
    { "filePath": "/abs/docs/old.md", "hunks": [ ... ], "deleted": true }
  ],
  "moreFiles": 0,
  "changedFiles": ["/abs/docs/notes.md", "/abs/docs/old.md"]
}
```

- `rm` -> one file with `deleted: true`. `git mv` -> one `created` and one `deleted`. `echo hi > new` -> `created: true` (also for untracked files).
- `hunks[].lines` holds file lines: it is dropped.
- A modified file with neither `created` nor `deleted` is an edit.

## `InstructionsLoaded`

- `session_start`: root `CLAUDE.md`, no `trigger_file_path`, before the first prompt.
- `nested_traversal`: `src/CLAUDE.md`, with `trigger_file_path` = the file that was read (`src/api/user.ts`).
- `path_glob_match`: `.claude/rules/api.md`, with the same `trigger_file_path`.
- When the subagent read `src/api/order.ts`, the `InstructionsLoaded` events repeated **without `agent_id`** (they are attributed to the main session).

## Order and timing

- Pre -> Post: `Read` 4-7 ms, `Edit`/`Write` 9-10 ms, `Bash` 11-193 ms, `Agent` 3.2 s.
- `PostToolBatch` arrives after every batch, even a single call.
- Subagent cycle: `PreToolUse(Agent)` -> `SubagentStart` -> tools with `agent_id` -> `SubagentStop` -> `PostToolUse(Agent)`.
- The request to read two files "in parallel" ran in sequence, so this capture has no two-call batch. The normalizer does not depend on the order.

## Changes to the model in section 5.2 of the plan

- `action: "search"` comes mostly from Bash; `secondary` is filled by parsing `stdout`.
- `create` vs `edit` in `Write` is confirmed with `tool_response.type`.
- `delete`, `create`, `move` and `edit` through Bash come from `bashEditDiff` when present; `move` = a `created` + `deleted` pair in the same call.
- `turn_start` uses `prompt_id`; tool events carry it so they can be grouped by turn.

## Skill and MCP (Claude Code 2.1.288)

Captured with Claude Code 2.1.288 in `test/fixtures/payloads/run-skill-mcp.jsonl`: one prompt that runs a skill and then calls the `resolve-library-id` tool of the `context7` MCP server (configured in the user settings). Both go through the same `PreToolUse` / `PostToolUse` / `PostToolBatch` hooks as any built-in tool, with the common fields plus `permission_mode`, `prompt_id`, `effort`, `tool_use_id` and, in Post, `duration_ms`.

**Skill.** `tool_name` is `"Skill"` and `tool_input` is `{skill: "<name>"}`. The `PostToolUse` `tool_response` is `{success: true, commandName: "<name>"}`. There is no path anywhere, and the skill's own files are not read through a `Read` hook. The normalizer emits action `skill` with `paths: []`, `detail` = the skill name and `tool: {kind: "skill", name}`.

**MCP.** `tool_name` is `mcp__<server>__<tool>` (here `mcp__context7__resolve-library-id`) and `tool_input` holds the MCP tool's own arguments. The payload adds a top-level `mcp_server: {name, source}` (here `{name: "context7", source: "user"}`), present in both Pre and Post. The `PostToolUse` `tool_response` is an array of MCP content blocks (`[{type: "text", text: ...}]`) that can carry anything the server returns. The normalizer emits action `mcp` with `detail` = `server/tool` and `tool: {kind: "mcp", server, name}`; the server name comes from `mcp_server.name` (the tool name only carries a normalized form of it, with characters outside `[A-Za-z0-9_-]` turned into `_`), or from the part between `mcp__` and the next `__` when the field is missing. It lights a path only when `tool_input` has a `file_path` or `path`. Neither the MCP arguments nor the response are forwarded or stored.
