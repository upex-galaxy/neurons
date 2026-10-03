# Neurons

Vista 3D en vivo de lo que hace Claude Code dentro de un repositorio. Cada archivo y carpeta es un nodo. Cuando Claude lee, busca, edita, crea o borra algo, una luz viaja desde la raíz hasta ese archivo con el color de la acción.

![Vista en vivo](docs/img/en-vivo.png)

Sirve para mirar cómo se mueve el agente: qué lee primero, cuánto explora antes de editar, qué instrucciones se cargan solas al contexto y qué hacen los subagentes.

## Requisitos

- Node 22.12 o superior (probado en 26).
- Claude Code con hooks HTTP. Probado con 2.1.285 en macOS arm64.
- git (opcional: sin git el árbol se arma recorriendo carpetas).

## Instalación

Todavía no está publicado en npm. Se instala desde este repo:

```bash
git clone <este repo> neurons
cd neurons
npm install
npm run build
npm link
```

`npm link` deja disponibles los comandos `neu` y `neurons` (son el mismo) en cualquier carpeta. Para quitarlos: `npm unlink -g neurons-cli`.

## Uso

```bash
cd mi-repo
neu
```

`neu` sin nada es lo mismo que `neu start`. Si estás en una subcarpeta, sube solo hasta la raíz del repositorio git y te avisa con `Usando la raíz del repositorio: <ruta>`. También podés pasar la carpeta: `neu ~/proyectos/api`.

Después abrí Claude Code en ese repo, como siempre. El navegador ya muestra la red y se ilumina con cada acción. `Ctrl+C` cierra el visor y deja todo como estaba.

| Comando | Qué hace |
|---|---|
| `neu [repo]` / `neu start [repo]` | Levanta el servidor, instala los hooks mientras corre y abre el navegador |
| `neu ls` | Lista los visores que están corriendo: repositorio, puerto, URL, PID y hora de arranque |
| `neu open [repo]` | Abre en el navegador el visor de ese repo. Sin repo abre el del repo en el que estás; si ahí no corre ninguno, abre el único que haya o, si hay varios, los lista |
| `neu stop [repo]` | Cierra el visor de ese repo (sus hooks se quitan al salir). `--all` cierra todos y `--force` lo mata si no cerró en 8 s |
| `neu replay [repo \| archivo.jsonl]` | Reproduce una sesión grabada |
| `neu doctor [repo]` | Revisa Node, hooks, allowlists, proxies y la interfaz compilada |
| `neu install [repo]` / `neu uninstall [repo]` | Instala o quita los hooks a mano (sirve para limpiar si el proceso murió de golpe) |
| `neu help` | Lista los comandos con sus opciones y ejemplos |

Opciones de `start`: `--port N` (7777 por defecto; si está ocupado usa el siguiente libre), `--strict-port`, `--no-open`, `--no-install`, `--no-bash-diff`.

Un nombre de comando gana sobre una carpeta que se llame igual: `neu stop` cierra un visor aunque exista `./stop`. Para levantar el visor sobre esa carpeta, usá `neu start stop`.

La guía paso a paso con un repo de ejemplo y un prompt para probar está en [docs/DEMO.md](docs/DEMO.md).

## Varios repos y varias sesiones

Cada repo tiene su propio visor, en su propio puerto: `neu` en un repo y `neu` en otro dan dos procesos, el segundo en 7778. `neu ls` muestra cuáles corren y `neu stop --all` los cierra todos. Dos visores sobre el mismo repo no pueden convivir; el segundo se niega a arrancar y te pide cerrar el primero.

Al arrancar, `start` busca sesiones de Claude Code que ya estén abiertas en el repo (con `ps` y `lsof` en macOS, `/proc` en Linux) y las nombra con su PID. No hace falta reiniciarlas: una sesión abierta toma los hooks en vivo, y al cerrar el visor los suelta sin ningún `hook error` (verificado con Claude Code 2.1.288). Solo si usás una versión anterior y no ves eventos de esa sesión, reiniciala con `/exit` y después `claude --continue`. Si no encuentra ninguna sesión, te pide que abras Claude Code.

Los subagentes que Claude Code lanza con aislamiento `worktree` trabajan en un checkout aparte, en `<repo>/.claude/worktrees/agent-<id>/`. Ese checkout nunca entra a la red, aunque tu `.gitignore` no lo ignore: lo que el subagente lee o edita ahí se ve sobre el archivo equivalente del repo principal (o sobre su carpeta más cercana, si el archivo solo existe en el worktree), y la fila del feed lleva la etiqueta `worktree`.

Varias sesiones sobre el mismo repo se ven en la misma red. Con dos o más sesiones activas, cada una recibe un tono suave propio: un anillo fino alrededor de los nodos que toca, un borde del mismo color en sus filas del feed y un chip en la línea "Sesiones" del panel que filtra por ella. Una sesión cuenta como activa mientras no terminó, o durante los 10 minutos siguientes a su último evento. Un `/clear` no cuenta como sesión nueva: la que se limpió deja de contar en el acto, porque la ventana sigue con la otra. Con una sola sesión la vista queda igual que siempre. Los subagentes conservan su halo propio y los cambios externos su gris, sin anillo de sesión.

## Qué toca en tu máquina

Mientras `start` corre:

1. Escribe hooks HTTP en `<repo>/.claude/settings.local.json`, que apuntan a `http://127.0.0.1:<puerto>/hook?src=neurons`. Si ya tenías hooks ahí, los conserva. Si el archivo no existía, lo crea.
2. Activa `bashEditDiffEnabled` en `~/.claude/settings.json` (o en `$CLAUDE_CONFIG_DIR`). Con eso Claude Code informa qué archivos cambió cada comando Bash, y un `rm` o un `git mv` se atribuyen con exactitud. Si ya estaba activado, no lo toca. `--no-bash-diff` lo evita. El registro de ese cambio (qué visores lo usan y una copia de la config) vive en `~/.claude/neurons/`, con permisos 0600.
3. Crea `<repo>/.neurons/` con el log de eventos y un lock. Esa carpeta y `settings.local.json` se agregan a `.git/info/exclude`, así que no aparecen en `git status`.
4. Anota el visor en `~/.neurons/viewers/<pid>.json` (repo, puerto, URL y PID) para que `ls`, `open` y `stop` lo encuentren. La variable `NEURONS_HOME` cambia esa carpeta.

Al cerrar con `Ctrl+C` (o `SIGTERM`, que es lo que manda `neu stop`) quita sus hooks, revierte `bashEditDiffEnabled` y borra su entrada en `~/.neurons/viewers`. Si no hubo otros cambios, los archivos quedan iguales byte a byte. Si el proceso muere de golpe, `neu uninstall <repo>` limpia, y el próximo `start` corrige solo lo que haya quedado.

Los hooks existen solo mientras el visor corre por un motivo concreto: si Claude Code tiene un hook HTTP apuntando a un servidor apagado, cada herramienta imprime un `hook error` en rojo. Con el visor cerrado no queda ningún hook.

`neu stop` solo manda señales a un proceso que `ps` confirma como el visor anotado: la misma línea de comando y un arranque no posterior al del visor. Un PID que quedó anotado y después reusó otro programa, u otro visor, no recibe nada. Nunca toca las sesiones de Claude Code.

## Si venías usando repo-synapse

Neurons se llamaba `repo-synapse` hasta el 2026-10-03. Lo que dejó la versión anterior se limpia solo:

- El primer `neu start`, `neu install` o `neu uninstall` sobre un repo quita los hooks viejos (`?src=repo-synapse`). Si quedó una instalación vieja sin limpiar (por ejemplo, porque el visor murió de golpe), primero la deshace como lo habría hecho la versión anterior: devuelve los bytes originales de `settings.local.json` o lo borra si lo había creado ella.
- `.repo-synapse/events.jsonl` se conserva. `neu replay` lo usa si el repo todavía no tiene `.neurons/events.jsonl`.
- El registro de `bashEditDiffEnabled` pasa de `~/.claude/repo-synapse/` a `~/.claude/neurons/`.
- `REPO_SYNAPSE_ALLOWED_ORIGINS` y `REPO_SYNAPSE_DEBUG` siguen funcionando; los nombres nuevos son `NEURONS_ALLOWED_ORIGINS` y `NEURONS_DEBUG`.

Si todavía corre un visor de la versión vieja sobre el repo, `neu start` se niega a arrancar: cerralo primero. Si la versión vieja arranca después, sobre un repo donde ya corre `neu`, al cerrar `neu` sus hooks y su instalación quedan intactos, y el registro de `bashEditDiffEnabled` se muda recién cuando no queda ningún visor viejo abierto.

Si la instalaste con `npm link`, quitá primero el link viejo y después enlazá este repo, en ese orden:

```bash
npm unlink -g repo-synapse
npm link
```

Al revés falla: el paquete viejo es dueño del comando `neu` y `npm link` corta con `EEXIST`. Si después queda un `repo-synapse` suelto en `$(npm prefix -g)/bin`, apunta a un archivo que ya no existe y se borra a mano. `npm link --force` también sirve: pisa el `neu` viejo.

## Qué se ve

| Acción | Color |
|---|---|
| Lectura | cian |
| Búsqueda (`find`, `grep`, `rg`...) | azul |
| Edición | ámbar |
| Creación | verde |
| Borrado | rojo |
| Movimiento | rosa |
| Instrucciones cargadas (`CLAUDE.md`, `.claude/rules`) | violeta |
| Otro comando Bash | blanco |
| Fallo | gris con parpadeo |
| Cambio externo (hecho fuera de Claude) | gris tenue |

La fase previa de una herramienta (Claude decidió usarla) es un pulso tenue; la fase final (terminó) es el pulso completo. Cada subagente pone un halo de color propio alrededor de los nodos que toca. Los archivos fuera del repo, como tus skills en `~/.claude` o `/tmp`, aparecen en un cúmulo aparte. Los nodos más tocados conservan brillo (heatmap).

El panel lateral tiene el feed en vivo, contadores por acción, filtros por sesión y por agente, el interruptor de cambios externos y el cambio entre 3D y 2D. En repos de más de 1.500 nodos las carpetas se colapsan y se abren solas cuando Claude entra en ellas.

![Replay](docs/img/replay.png)

## Cómo funciona

La explicación visual completa, con diagramas animados, está en [docs/arquitectura.html](docs/arquitectura.html): abrila en el navegador.

```
Claude Code ──hook HTTP (POST)──▶ servidor 127.0.0.1 ──WebSocket──▶ navegador
                                      ▲         │
                  fs.watch recursivo ─┘         └──▶ .neurons/events.jsonl
```

- El servidor responde `204` vacío antes de procesar, así Claude Code nunca espera ni recibe una decisión. Cada hook tiene `timeout: 2`.
- Normaliza cada payload a un evento con rutas relativas al repo. Nunca manda al navegador ni guarda en el log contenido de archivos (`content`, `old_string`, diffs, salida de comandos): solo rutas y metadatos.
- Un watcher (`fs.watch` recursivo, FSEvents en macOS) ve los cambios de disco. Si pasan dentro de la ventana de un comando Bash de Claude se le atribuyen; si no, se marcan como externos.

Los payloads reales que manda Claude Code 2.1.285 están documentados en [docs/PAYLOADS.md](docs/PAYLOADS.md). El plan está en [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) y las decisiones con sus motivos en [docs/DECISIONS.md](docs/DECISIONS.md).

## Desarrollo

```bash
npm run build        # interfaz (Vite) + CLI (tsdown) en dist/
npm run typecheck
npm test             # build + Vitest (servidor y web) + Playwright
npm run dev -- start ../otro-repo   # CLI desde src con tsx (usa la web de dist/)
```

La primera vez, Playwright necesita `npx playwright install chromium`.

## Limitaciones conocidas

- Solo se probó en macOS. En Linux `fs.watch` recursivo usa inotify y no está verificado.
- Que una sesión ya abierta tome los hooks sin reiniciar se verificó con Claude Code 2.1.288; con versiones anteriores puede hacer falta `/exit` y `claude --continue`.
- Sin `bashEditDiff`, la atribución de `rm` y `mv` depende de ventanas de tiempo y del watcher; un `rm x; cp -p y z` puede mostrarse como un movimiento.
- Las sesiones de Claude Code en la web o en la nube no llegan a un servidor local.
