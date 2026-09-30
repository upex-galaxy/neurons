# Payloads reales (fase 0)

Capturados el 2026-09-30 con **Claude Code 2.1.285** (build nativo, macOS arm64), sesiones headless `claude -p` con `claude-sonnet-5-5`, contra un repo desechable con `CLAUDE.md`, `src/CLAUDE.md` y `.claude/rules/api.md` (con `paths: src/api/**/*.ts`).

Herramientas: `scripts/probe/recorder.mjs` (servidor que responde `204` vacío y guarda cada POST), `scripts/probe/make-settings.mjs` (genera los hooks) y `scripts/probe/extract-fixtures.mjs` (reemplaza la raíz del repo por `__REPO__` y el home por `__HOME__`).

Fixtures: `test/fixtures/payloads/run1.jsonl` (39 eventos: búsqueda, lecturas, edición, creación, `rm`, `git mv`, comando fallido, subagente) y `run3.jsonl` (`rm` y `echo >` con `bashEditDiffEnabled`).

## Transporte

- Cabeceras: `content-type: application/json`, `user-agent: axios/1.15.2`, `connection: keep-alive`. La query `?src=...` de la URL llega intacta.
- El log de depuración confirma: `HTTP hook response status 204, body length 0` -> `HTTP hook returned empty body, treating as empty JSON object`.
- Cada POST tardó alrededor de 1 ms de ida y vuelta en loopback.
- Los hooks declarados en `<repo>/.claude/settings.local.json` se ejecutan en modo `-p` (run 2), así que la ruta de instalación elegida funciona.

## Campos por evento

| Evento | Campos observados |
|---|---|
| `InstructionsLoaded` | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `file_path`, `memory_type`, `load_reason`, `trigger_file_path`? |
| `UserPromptSubmit` | comunes + `permission_mode`, `prompt_id`, `prompt` |
| `PreToolUse` | comunes + `permission_mode`, `prompt_id`, `effort`, `tool_name`, `tool_input`, `tool_use_id`, y `agent_id`/`agent_type` dentro de un subagente |
| `PostToolUse` | lo de `PreToolUse` + `tool_response`, `duration_ms` |
| `PostToolUseFailure` | lo de `PreToolUse` + `error` (texto, p. ej. `Exit code 1\ncat: ...`), `is_interrupt`, `duration_ms` |
| `PostToolBatch` | comunes + `tool_calls[]` con `tool_name`, `tool_input`, `tool_use_id`, `tool_response` |
| `SubagentStart` | comunes + `prompt_id`, `agent_id`, `agent_type` |
| `SubagentStop` | comunes + `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| `Stop` | comunes + `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| `SessionEnd` | comunes + `prompt_id`, `reason` (`other` en `-p`) |

`prompt_id` falta antes del primer prompt (`InstructionsLoaded` de `session_start`). `permission_mode` y `effort` faltan en algunos eventos. El normalizador trata todo como opcional salvo `session_id` y `hook_event_name`.

## `tool_input` y `tool_response` por herramienta

| Herramienta | `tool_input` | `tool_response` (claves) |
|---|---|---|
| `Read` | `file_path` (absoluta) | `type: "text"`, `file: {filePath, content, numLines, startLine, totalLines}` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` | `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified`, `replaceAll` |
| `Write` | `file_path`, `content` | `type: "create"` o `"update"`, `filePath`, `content`, `structuredPatch`, `originalFile`, `userModified` |
| `Bash` | `command`, `description` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`, y `bashEditDiff` si está activado |
| `Agent` | `description`, `prompt`, `subagent_type` | `status`, `agentId` (igual al `agent_id` de los hooks del subagente), `agentType`, `content`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage`, `toolStats`, ... |

Casi todas las respuestas traen contenido de archivos (`content`, `originalFile`, `structuredPatch`, `hunks`, `stdout`). El normalizador lee solo rutas y metadatos.

## Búsquedas

Pedido "encontrá todos los `.ts` y buscá `TODO`": Claude ejecutó **un solo Bash** `find . -name "*.ts" ...; grep -rn "TODO" . ...`. No aparecieron herramientas `Glob` ni `Grep` (no existen en este build). `stdout` trae rutas (`./src/api/user.ts`) y líneas `ruta:línea:texto`; de ahí se extraen rutas para el destello secundario, sin reenviar el texto.

## `bashEditDiff`

Aparece en `PostToolUse(Bash).tool_response` **solo** si `bashEditDiffEnabled: true` está en la configuración de usuario (`~/.claude/settings.json`) o en `--settings`. En `.claude/settings.local.json` se ignora (run 2).

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

- `rm` -> un archivo con `deleted: true`. `git mv` -> uno `created` y uno `deleted`. `echo hi > nuevo` -> `created: true` (también en archivos no versionados).
- `hunks[].lines` contiene líneas del archivo: se descarta.
- Un archivo modificado sin `created` ni `deleted` es una edición.

## `InstructionsLoaded`

- `session_start`: `CLAUDE.md` raíz, sin `trigger_file_path`, antes del primer prompt.
- `nested_traversal`: `src/CLAUDE.md`, con `trigger_file_path` = el archivo leído (`src/api/user.ts`).
- `path_glob_match`: `.claude/rules/api.md`, con el mismo `trigger_file_path`.
- Cuando el subagente leyó `src/api/order.ts`, los `InstructionsLoaded` se repitieron **sin `agent_id`** (se atribuyen a la sesión principal).

## Orden y tiempos

- Pre -> Post: `Read` 4-7 ms, `Edit`/`Write` 9-10 ms, `Bash` 11-193 ms, `Agent` 3,2 s.
- `PostToolBatch` llega después de cada lote, incluso de una sola llamada.
- Ciclo del subagente: `PreToolUse(Agent)` -> `SubagentStart` -> herramientas con `agent_id` -> `SubagentStop` -> `PostToolUse(Agent)`.
- El pedido de leer dos archivos "en paralelo" se ejecutó en secuencia, así que no hubo lote de dos llamadas en esta captura. El normalizador no depende del orden.

## Cambios al modelo de la sección 5.2 del plan

- `action: "search"` sale sobre todo de Bash; `secondary` se llena parseando `stdout`.
- `create` vs `edit` en `Write` se confirma con `tool_response.type`.
- `delete`, `create`, `move` y `edit` por Bash salen de `bashEditDiff` cuando está; `move` = par `created` + `deleted` en la misma llamada.
- `turn_start` usa `prompt_id`; los eventos de herramienta lo traen para agrupar por turno.
