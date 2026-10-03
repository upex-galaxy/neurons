# repo-synapse: plan de implementación

> El 2026-10-03 el producto pasó a llamarse **Neurons** (comando `neu`). Este plan quedó como se escribió, con los nombres de entonces: `repo-synapse` es hoy `neu`, `.repo-synapse/` es `.neurons/` y `?src=repo-synapse` es `?src=neurons`. El cambio y la compatibilidad con lo viejo están en `DECISIONS.md` (I28).

Plan definitivo, escrito antes de implementar. Parte del documento de idea original y lo corrige con lo verificado contra la documentación oficial (`code.claude.com/docs/en/hooks`, `hooks-guide`, `settings`) y contra el binario instalado (`claude 2.1.285`, macOS arm64). Las decisiones y sus motivos están en `DECISIONS.md`.

## 1. Qué construimos

Un CLI de Node (`repo-synapse`) que, apuntado a un repositorio:

1. Construye el árbol del repo (`git ls-files --cached --others --exclude-standard`, o recorrido con exclusiones si no es git).
2. Levanta un servidor en `127.0.0.1:<puerto>` que recibe hooks HTTP de Claude Code, los normaliza a `VizEvent`, los guarda en `.repo-synapse/events.jsonl` y los emite por WebSocket.
3. Instala sus hooks en `<repo>/.claude/settings.local.json` al arrancar y los quita al salir.
4. Sirve una página 3D (3d-force-graph + bloom) donde cada archivo y carpeta es un nodo y la luz viaja raíz -> carpeta -> archivo con el color de la acción.

```
Claude Code ──POST /hook (http hook, 204 vacío)──▶ servidor 127.0.0.1:7777 ──WS /ws──▶ navegador
                                                     ▲        │
                              fs.watch recursivo ────┘        └──▶ .repo-synapse/events.jsonl
```

## 2. Hechos verificados que condicionan el diseño

| Hecho | Consecuencia |
|---|---|
| HTTP hook: 2xx con body vacío = sin decisión. Body de texto plano (`OK`) = error no bloqueante visible | `POST /hook` responde `204` sin body, antes de procesar. Nunca JSON con campos de decisión |
| Servidor caído: cada evento de herramienta muestra `<Evento> hook error` en rojo | Los hooks solo existen mientras corre `start` (se instalan al arrancar, se quitan al salir) |
| Servidor colgado: la tool call espera hasta `timeout` (default 600 s) | `timeout: 2` en cada hook; el handler hace ack inmediato |
| `SessionStart` y `Setup` no admiten `type: "http"` | La sesión se crea al ver el primer `session_id` |
| No hay `async` para hooks HTTP | Respuesta inmediata; el trabajo pesado va después del `res.end()` |
| Guard SSRF: solo loopback. `allowedHttpHookUrls` compara el host literal | URL fija `http://127.0.0.1:<port>/hook?src=repo-synapse`; `doctor` revisa allowlist y proxies |
| `maxRedirects: 0` | `/hook` se sirve directo, sin normalizar barras |
| Payloads grandes (`Read` trae el contenido en `tool_response`) | Sin límite chico de body; se descarta todo contenido al normalizar |
| Build nativo de macOS: no hay herramientas `Glob`/`Grep`; Claude busca con `bfs`/`ugrep`/`grep`/`rg` vía Bash | Clasificador de comandos Bash (búsqueda, borrado, movimiento). Handlers de Glob/Grep se mantienen por compatibilidad |
| `PostToolUse(Bash).tool_response.bashEditDiff` puede listar archivos cambiados (`bashEditDiffEnabled`, solo en config de usuario) | Atribución exacta cuando está; watcher + ventanas como respaldo. Se confirma en la fase 0 |
| `PostToolBatch`, `PostToolUseFailure` (`error`, `is_interrupt`), `InstructionsLoaded` (`file_path`, `memory_type`, `load_reason`, `trigger_file_path`, sin `agent_id`) existen | Se registran todos |
| Subagente se identifica por `agent_id` (no por `agent_type`) | Color por `agent_id` |
| Post puede llegar en cualquier orden con llamadas en paralelo; una cancelación no dispara Post | Ventanas por `tool_use_id`, cierre también en `Stop`, `UserPromptSubmit` siguiente y TTL |
| No suscribirse a `WorktreeCreate`/`WorktreeRemove`/`PreModelSwitch` | Un receptor pasivo rompe esos flujos |
| chokidar 5 en macOS abre un fd por archivo (EMFILE a ~60k) | `fs.watch(root, {recursive: true})` (FSEvents) + clasificación por `stat` + índice propio |
| `emitParticle(link)` exige el objeto link vivo y cubre un solo salto; la velocidad es por frame | Mapa `parent->child` a links vivos; saltos encadenados con retardo |

## 3. Stack

Node >= 22.12 (probado en 26), TypeScript, ESM. Servidor con `node:http` + `ws` (sin framework). Frontend con Vite + TS, `3d-force-graph` 1.80, `three` 0.186, `force-graph` para el modo 2D. Build del CLI con `tsdown`, desarrollo con `tsx`. Pruebas con Vitest 5 y Playwright.

## 4. Estructura del repo

```
src/
  cli.ts                 comandos start | install | uninstall | replay | doctor
  shared/types.ts        VizEvent, TreeNode, mensajes WS
  server/
    server.ts            node:http + ws, rutas, ring buffer, broadcast
    tree.ts              escaneo inicial e índice de rutas
    paths.ts             relativización, dentro/fuera del repo
    normalize.ts         payload de hook -> VizEvent[]
    bash.ts              clasificador de comandos Bash
    attribution.ts       ventanas por tool_use_id, dedupe, bashEditDiff
    watcher.ts           fs.watch recursivo + clasificación
    eventlog.ts          append a .repo-synapse/events.jsonl
  install/settings.ts    merge/unmerge de hooks, backup, manifiesto, exclude
web/                     frontend Vite (index.html, src/*.ts)
scripts/probe/           grabador y guion de la fase 0
scripts/make-demo-repo.sh
test/unit | test/integration | test/e2e | test/fixtures/payloads
docs/
```

## 5. Modelo de evento

```ts
type Action = "read" | "edit" | "create" | "delete" | "move" | "search" | "bash"
  | "context_load" | "subagent_start" | "subagent_stop" | "turn_start" | "turn_end"
  | "session_start" | "session_end" | "batch_end" | "compact" | "tool";

type VizEvent = {
  id: string; ts: number; sessionId: string; promptId?: string;
  agentId?: string; agentType?: string; toolUseId?: string; toolName?: string;
  phase: "pre" | "post" | "fail" | "info";
  action: Action;
  paths: string[];          // relativas al repo, con "/"
  outsideRepo?: string[];   // absolutas, fuera del repo
  secondary?: string[];     // resultados de búsqueda (destello secundario)
  detail?: string;          // patrón, comando truncado a 120, load_reason
  source: "hook" | "watcher";
  external?: boolean;       // cambio de disco sin ventana de Claude
};
```

Mensajes WS servidor -> cliente: `hello` (raíz, árbol, últimos 500 eventos, sesiones), `event`, `tree` (`added`, `removed`). Se ajusta tras la fase 0.

## 6. Reglas de normalización

- `Read` -> `read`. `Edit`, `MultiEdit`, `NotebookEdit` -> `edit`. `Write` -> `create` si el archivo no existe en el `PreToolUse` (se recuerda por `tool_use_id`; en Post manda `tool_response.type` si viene).
- `Glob`/`Grep` -> `search` sobre `tool_input.path` (resuelto contra `cwd`) o la raíz; rutas de `tool_response` como `secondary`.
- `Bash`: clasificación del comando. Búsqueda (`grep`, `rg`, `ugrep`, `bfs`, `find`, `fd`, `ls`, `tree`, `ag`) -> `search`; `rm`/`git rm`/`unlink`/`rmdir` -> `delete`; `mv`/`git mv` -> `move`; el resto -> `bash`. Rutas candidatas: argumentos que resuelven dentro del repo. En Post, `bashEditDiff` produce eventos exactos por archivo.
- `Agent`/`Task` -> `tool` con la descripción; el ciclo de vida sale de `SubagentStart`/`SubagentStop`.
- `InstructionsLoaded` -> `context_load` sobre `file_path` (satélite si está fuera), `detail` = `load_reason`.
- `UserPromptSubmit` -> `turn_start` (prompt truncado a 120). `Stop` -> `turn_end`. `SessionEnd` -> `session_end`. `PostToolBatch` -> `batch_end`. `PreCompact`/`PostCompact` -> `compact`.
- `PostToolUseFailure` -> misma acción con `phase: "fail"`.
- Nunca se reenvía ni se persiste `content`, `old_string`, `new_string`, `tool_response` crudo ni diffs.

## 7. Watcher y atribución

- Índice en memoria desde el escaneo inicial. `fs.watch` recursivo; por cada ruta, coalescencia de 40 ms y `lstat` para decidir `add`/`addDir`/`change`/`unlink`/`unlinkDir`. Un par `unlink`+`add` dentro de la misma ventana se reporta como `move`.
- Exclusiones: `.git`, `node_modules`, `.repo-synapse`, `dist`, `build`, más lo que `git check-ignore` marque (consulta asíncrona para rutas nuevas).
- Ventanas: `PreToolUse(Bash)` abre una ventana por `tool_use_id`; `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop` y el siguiente `UserPromptSubmit` la cierran, con 600 ms de gracia para la latencia de FSEvents; TTL de 10 minutos.
- Cambios de disco dentro de una ventana: evento `source: "watcher"` atribuido a esa sesión/agente. Fuera de toda ventana: `external: true`.
- Dedupe: un cambio de disco sobre una ruta con Edit/Write en curso (o reportada por `bashEditDiff` en los últimos 2 s) no genera evento nuevo, pero sí actualiza el árbol.
- Toda creación o borrado emite un mensaje `tree`, sea de Claude o externo.

## 8. Instalación de hooks

- Archivo: `<repo>/.claude/settings.local.json`. Eventos: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `InstructionsLoaded`, `Stop`, `StopFailure`, `SessionEnd`, `PreCompact`, `PostCompact`. Sin `matcher`, `timeout: 2`.
- Identidad propia: la URL exacta termina en `/hook?src=repo-synapse`. Install = quitar las entradas propias y agregar las nuevas (idempotente, corrige puertos viejos). Uninstall = quitar solo coincidencias exactas y limpiar arreglos y objetos que quedaron vacíos por nosotros.
- Backup antes de la primera escritura (`.repo-synapse/settings.local.json.bak`) y manifiesto (`.repo-synapse/install.json`) con lo que se creó. Si al desinstalar el contenido coincide con el backup, se restauran los bytes originales; si el archivo no existía, se borra.
- JSON inválido: se aborta, nunca se sobrescribe. Escritura atómica (temp + rename).
- `.claude/settings.local.json` y `.repo-synapse/` se agregan a `.git/info/exclude` si git no los ignora ya.
- `bashEditDiffEnabled`: solo si la fase 0 confirma que llega en el payload HTTP. `start` lo activa en `~/.claude/settings.json` (respetando `CLAUDE_CONFIG_DIR`) si no estaba, y lo revierte al salir. Varios visores lo comparten: se revierte cuando sale el último (ver I15 en `DECISIONS.md`).
- `start` instala al arrancar y desinstala con SIGINT/SIGTERM/exit. Lockfile con PID para evitar dos procesos sobre el mismo repo.

## 9. Frontend

- Nodos: raíz, carpetas, archivos; links padre -> hijo. Layout `d3` con `dagMode: "radialout"` y `dagLevelDistance` fijo, warmup y cooldown cortos.
- Luz: por evento, cadena visible raíz -> ... -> destino; `emitParticle` por salto cada 80 ms; color, ancho y velocidad leídos del link en el momento de emitir.
- Nodo destino: brillo y escala con decaimiento de 3,5 s. Fase `pre` = pulso tenue; `post` = pulso completo; `fail` = gris con parpadeo.
- Colores: read `#22d3ee`, search `#3b82f6`, edit `#f59e0b`, create `#22c55e`, delete `#ef4444`, move `#f472b6`, context_load `#a855f7`, bash `#e2e8f0`, fail `#6b7280`, externos gris tenue.
- Subagentes: tono de halo por `agent_id`.
- Satélites: rutas fuera del repo agrupadas bajo un hub aparte (`~/.claude`, `/tmp`, otros).
- Estructura: `tree` agrega nodos (aparecen junto al padre) o los quita con fade; actualizaciones de `graphData` agrupadas cada 150 ms.
- Heatmap: contador por nodo; brillo residual proporcional a `count / max`.
- Colapso: con más de 1.500 nodos visibles se colapsan carpetas por profundidad; una carpeta colapsada se expande sola al recibir actividad.
- Panel: feed en vivo (hora, sesión, agente, acción, ruta), contadores por acción, filtros por sesión y agente, toggle de externos, toggle 3D/2D.
- `window.__vizState` expone nodos, activos, creados, eliminados, fps y feed para las pruebas.

## 10. Replay

`repo-synapse replay [repo]` sirve la misma página en modo replay: carga `events.jsonl`, reconstruye el árbol inicial y reproduce con play, pausa y velocidad 1x/2x/5x. La página en vivo también puede reproducir el log actual.

## 11. Pasos (un commit por paso)

| # | Paso | Entregable verificable |
|---|---|---|
| 0 | Scaffold y docs | `package.json`, `tsconfig`, este plan, `DECISIONS.md` |
| 1 | Fase 0: sonda de payloads | `scripts/probe/*`, `docs/PAYLOADS.md`, fixtures reales en `test/fixtures/payloads` |
| 2 | Tipos compartidos y protocolo | `src/shared/types.ts` ajustado a los payloads reales |
| 3 | Árbol y rutas | `tree.ts`, `paths.ts` + pruebas |
| 4 | Normalizador y clasificador Bash | `normalize.ts`, `bash.ts` + una prueba por herramienta con fixtures |
| 5 | Watcher y atribución | `watcher.ts`, `attribution.ts` + pruebas de ventanas y dedupe |
| 6 | Servidor | `server.ts`, `eventlog.ts` + integración (POST -> WS + jsonl) |
| 7 | Instalador | `install/settings.ts` + pruebas de merge/unmerge byte a byte |
| 8 | CLI | `start`, `install`, `uninstall`, `replay`, `doctor`, puerto libre, lock |
| 9 | Grafo base | escena 3D, bloom, luz por ruta, colores |
| 10 | Grafo completo | árbol dinámico, satélites, subagentes, heatmap, colapso, panel, 2D |
| 11 | Replay | modo replay y controles |
| 12 | E2E y rendimiento | Playwright + medición con 2.000 archivos |
| 13 | Demo y README | `make-demo-repo.sh`, `DEMO.md`, README, prueba de humo real |

## 12. Pruebas

- Unitarias: normalizador (fixtures reales por herramienta), creación vs edición, relativización, clasificador Bash, atribución dentro y fuera de ventana, dedupe, instalador (preserva hooks ajenos, uninstall restaura bytes).
- Integración: servidor real en puerto aleatorio; POST de fixtures; se verifica respuesta `204` vacía, mensajes WS, `events.jsonl` sin contenido de archivos, y atribución de un `rm` real contra un borrado externo.
- E2E: Playwright abre la página, inyecta una secuencia por `POST /hook` y comprueba feed y `window.__vizState`.
- Rendimiento: repo sintético de 2.000 archivos, fps medido en `__vizState`.
- Humo: sesión real `claude -p` sobre el repo de demo con el guion de `DEMO.md`.
- Todo con `npm test`.

## 13. Criterios de aceptación y cómo se verifican

| Criterio | Verificación |
|---|---|
| Latencia < 300 ms | Integración: `ts` de recepción vs mensaje WS; E2E: evento -> nodo activo |
| Servidor apagado sin errores visibles | Los hooks se quitan al salir; prueba de uninstall + `doctor` |
| Sin contenido de archivos en navegador ni en jsonl | Integración con payloads que traen `content`, `old_string`, `new_string` y búsqueda de esos strings |
| 7 acciones + fallos + subagentes distinguibles | Colores y halos; E2E revisa `__vizState` |
| `rm` de Claude = `delete` atribuido; `rm` externo no | Integración con ventana Bash abierta vs cerrada |
| install preserva, uninstall restaura | Unitarias byte a byte |
| 2.000 archivos a 30 fps | Medición con navegador con GPU, registrada en `DECISIONS.md` |
| `npm test` pasa | CI local |
