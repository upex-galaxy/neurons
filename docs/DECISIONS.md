# Decisiones

Registro de decisiones con su motivo. Las marcadas "ronda" salen de la ronda de preguntas (respuesta: "todo default"). Las demás las tomé durante la implementación eligiendo lo más simple que cumple los criterios.

## Ronda de preguntas (2026-09-30)

| # | Tema | Decisión | Motivo |
|---|---|---|---|
| D1 | Transporte de hooks | Hooks `type: "http"`, escritos por `repo-synapse start` en `<repo>/.claude/settings.local.json` y quitados al salir | Con el servidor apagado, un hook HTTP permanente imprime `hook error` en rojo en cada tool call (verificado en el binario 2.1.285). Instalar solo mientras corre el visor cumple el criterio 8.2 sin perder la latencia de HTTP |
| D2 | Runtime | Node >= 22.12 + TypeScript, `node:http` + `ws`, sin framework | Una ruta POST, estáticos y un upgrade WS no justifican framework. `tsx` en desarrollo, `tsdown` para el bin (tsup está sin mantenimiento) |
| D3 | Vista | 3D con `3d-force-graph` + bloom, Vite + TS, toggle 2D con `force-graph` | Vite garantiza una sola copia de three.js para el grafo y `UnrealBloomPass` |
| D4 | Alcance | Un repo por proceso, varias sesiones y subagentes con filtros | Simplicidad; dos repos = dos procesos |
| D5 | Puerto | `7777`, y si está ocupado el siguiente libre | Posible porque `start` escribe el puerto real en los hooks |
| D6 | Cambios externos | Se muestran en gris tenue, con toggle | Distinguir Claude de lo externo es parte del objetivo didáctico |
| D7 | `bashEditDiffEnabled` | Probarlo en la fase 0; si llega en el payload HTTP, `start` lo activa en la config de usuario y lo revierte al salir | Da atribución exacta de `rm`/`mv` |
| D8 | Fase 0 | Sesiones reales `claude -p` con presupuesto limitado | Payloads reales de la versión instalada, no supuestos |
| D9 | Distribución | Paquete npm listo, no publicado; uso vía `npm link` | Publicar es decisión del usuario |
| D10 | Nombre e idioma | `repo-synapse`; UI y README en español; código y commits en inglés | Ronda |
| D11 | Escala | Calibrado para 5.000 archivos; colapso por encima de 1.500 nodos visibles | Tamaño del repo real no informado |
| D12 | Sonido | No se implementa | Ronda |
| D13 | Git | Commits en `main`, sin push | Ronda |

## Implementación

| # | Decisión | Motivo |
|---|---|---|
| I1 | Watcher con `fs.watch(root, {recursive: true})` nativo, no chokidar | chokidar 5 abre un fd por archivo en macOS y falla con `EMFILE` en repos grandes; `fs.watch` recursivo usa FSEvents |
| I2 | Identidad de los hooks propios por URL exacta con `?src=repo-synapse` | Un prefijo como `http://127.0.0.1` borraría hooks de otras herramientas (bug documentado en agent-flow) |
| I3 | `POST /hook` responde `204` sin body antes de procesar | Un body de texto genera `hook error`; un JSON podría interpretarse como decisión |
| I4 | La sesión se crea con el primer evento que trae un `session_id` nuevo | `SessionStart` no admite hooks HTTP |
| I5 | Búsquedas detectadas clasificando comandos Bash | En el build nativo de macOS no existen las herramientas Glob/Grep |
| I6 | `.claude/settings.local.json` y `.repo-synapse/` van a `.git/info/exclude` si git no los ignora | No se asume el auto-gitignore; `info/exclude` no toca archivos versionados |
| I7 | `bashEditDiffEnabled` se activa en `~/.claude/settings.json` (o en `$CLAUDE_CONFIG_DIR/settings.json`) mientras corre `start`, y se revierte al salir, solo si no estaba ya | Fase 0: el campo llega en el payload HTTP pero solo si la clave está en la config de usuario; en `settings.local.json` se ignora |
| I8 | Rutas de resultados de búsqueda extraídas de `stdout` de Bash (líneas `ruta` o `ruta:línea:`), validadas contra el índice del árbol | Es la única fuente de resultados en el build nativo; el texto nunca sale del servidor |
| I9 | No verificado: si los hooks agregados a `settings.local.json` con una sesión interactiva ya abierta se aplican sin reiniciar | `-p` no permite probarlo. `DEMO.md` indica arrancar el visor antes que Claude |
| I10 | Rendimiento medido (2026-09-30): repo sintético de 2.000 archivos (2.107 nodos, 1.747 visibles tras el colapso), vista 3D con bloom, 49 eventos `Read` en 5 s por `POST /hook`. Chromium de Playwright con `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`, renderer `ANGLE Metal Renderer: Apple M4`: **60 fps** de mediana, 60 de media y 60 de mínimo. Es el tope de `requestAnimationFrame`, así que el margen real no se ve | `test/e2e/perf.spec.ts` solo exige 30 fps si el contexto WebGL es por GPU; con SwiftShader o llvmpipe se salta y deja el valor anotado |
| I11 | E2E sobre el CLI compilado real (`dist/cli.mjs`), un servidor por spec (live 7791, replay 7792, perf 7793) lanzado por `scripts/e2e/serve.mjs` sobre repos temporales, con `CLAUDE_CONFIG_DIR` temporal | Probar lo que se distribuye, no un servidor falso. El lanzador verifica al salir que `start --no-install` no tocó ni el `settings.json` centinela ni `.claude/settings.local.json` |
| I12 | El `detail` de Bash es la primera línea lógica del comando, sin el cuerpo de los heredoc; si la línea escribe archivos (`>`, `>>`, `tee`, `sed -i`) o corre código en línea (`python -c`, `node -e`, `bash -c`...), los literales entre comillas y los argumentos de `echo`/`printf` se reemplazan por `…` | Un comando de Bash puede traer el contenido que escribe (`cat > .env <<EOF`), y ese texto no puede llegar al navegador ni a `events.jsonl` |
| I13 | `/ws` y `/hook` aceptan solo el origen del propio servidor (`http://127.0.0.1:<puerto>` y `http://localhost:<puerto>`) y los que se agreguen con `REPO_SYNAPSE_ALLOWED_ORIGINS` (por ejemplo `http://localhost:5173` para `vite` en desarrollo) | Una página servida en otro puerto local podía leer el stream o inyectar hooks. No se usa `rewriteWsOrigin` de Vite porque deja pasar cualquier origen |
| I14 | `start` agrega `.repo-synapse/` a `.git/info/exclude` siempre, también con `--no-install`; si el exclude no se puede escribir, se avisa y se sigue | `events.jsonl` lista el repo y no debe terminar en un commit; un exclude de solo lectura no debe dejar hooks a medio instalar |
| I15 | El registro del cambio de `bashEditDiffEnabled` vive fuera del repo, en `$CLAUDE_CONFIG_DIR/repo-synapse/` (`bash-diff.json` con los visores que lo usan, repo y PID, y `settings.json.bak`; modo 0600). Se revierte cuando sale el último visor vivo; si no se puede (JSON inválido, error de escritura) el registro queda y el próximo `start` o `uninstall` reintenta | La copia de la config de usuario puede tener tokens y no debe quedar en el repo; la clave es global y la comparten visores de repos distintos |
| I16 | El watcher informa `move` cuando empareja un unlink con un add: mismo inodo, misma ruta con otra capitalización, o mismo nombre / único par del lote si la entrada no nació recién (birthtime de más de 1 s). Un unlink sin pareja espera 200 ms antes de salir, y los unlink de hijos que esperan se descartan si después llega el `unlinkDir` del padre | `fs.watch` no trae renames; sin esto un `mv` se veía como borrado más alta. FSEvents a veces entrega los hijos de un `rm -r` un lote antes que el directorio |
| I17 | El `lstat` del watcher verifica con `readdir` la capitalización exacta de cada segmento | En APFS, después de `mv Foo.ts foo.ts`, `lstat('Foo.ts')` sigue funcionando y quedaba un nodo fantasma |
| I18 | Hook y watcher se deduplican por ventana de Bash, no por 2 s fijos. Lo que el watcher ya mostró durante la ventana de un `tool_use_id` se quita del Post de ese Bash, pero solo si mostró el mismo estado (existe o ya no existe); un directorio nuevo no cubre los archivos creados después dentro de él. Lo que mostró el hook suprime al watcher después | Un comando largo repetía eventos al vencer los 2 s; y un archivo creado y borrado por el mismo comando perdía el borrado si se comparaba solo la ruta |
| I19 | Un `rm`/`mv` de Bash sin `bashEditDiff` no toca el árbol: lo actualiza el watcher. Un glob, las raíces de `find -delete` y `rm -rf .` pasan a ser `bash`, no `delete`. `mv` da `paths` con las rutas nuevas y `fromPaths` con las viejas, alineadas | La línea de comando es una suposición; el disco dice lo que pasó |
| I20 | La atribución a una ventana usa la hora en que el watcher vio el cambio (`DiskChange.ts`), no la hora en que se procesa. Las ventanas cerradas se conservan 5 s más | Un flush tardío atribuía mal cambios externos vistos antes del `PreToolUse` |
| I21 | Fuera de git, los hooks no agregan al índice rutas bajo `DEFAULT_EXCLUDES`; el watcher igual informa la baja de una ruta excluida que el índice conoce | Coherencia con el escaneo inicial; sin esto `build/` entraba al árbol y no salía nunca |
| I22 | Durante los 10 s siguientes al arranque, un cambio en `.claude/settings.local.json` actualiza el árbol sin generar evento; su archivo temporal atómico nunca genera evento | Es la instalación de los hooks del propio `start`, no un cambio externo |
| I23 | El lock guarda `pid`, `startedAt` y `cmd` (el script del CLI). Es viejo si el PID murió o si el proceso arrancó más de 5 s después de `startedAt` (`ps -o etime`) y su línea de comando no nombra `cmd`. El rechazo por lock vivo dice qué archivo borrar | Un PID reutilizado tras un reinicio bloqueaba `start` para siempre. `cmd` evita que un salto del reloj de pared (NTP, VM que se reanuda) haga ver como viejo a un dueño vivo |
| I24 | El lock se crea con archivo temporal + hard link (nunca se ve vacío). Tomar un lock viejo se serializa con un guardia exclusivo `lock.takeover`: quien lo tiene compara el contenido y recién ahí borra; nunca se mueve un lock fresco. Un guardia de un proceso muerto o de más de 10 s se limpia | Con tres o más `start` en carrera, renombrar el lock antes de verificarlo dejaba ganar a dos |
| I25 | `install` se niega solo si hay un `start` vivo sobre el repo y existe su manifiesto de instalación | Reescribir los hooks del visor los apuntaría a otro puerto; con `start --no-install` no hay nada que proteger |
