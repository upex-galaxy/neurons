# Guion de demo

Probado el 2026-09-30 con Claude Code 2.1.285 en macOS (todavía con el nombre `repo-synapse`; los comandos de abajo ya usan `neu`), sobre el repo que genera `scripts/make-demo-repo.sh`. Los tiempos y conteos de abajo son de esa corrida.

## 1. Instalar, iniciar y abrir la vista

Desde este repo, una sola vez:

```bash
npm install
npm run build
npm link            # deja los comandos globales `neu` y `neurons`
```

Si antes enlazaste la versión vieja (`repo-synapse`), corré `npm unlink -g repo-synapse` antes del `npm link`: si no, falla con `EEXIST` porque el paquete viejo es dueño de `neu`. El README explica el resto de la migración.

Crear el repo de ejemplo (14 archivos, con `CLAUDE.md`, `src/CLAUDE.md` y una regla en `.claude/rules/api.md`):

```bash
scripts/make-demo-repo.sh ~/neurons-demo
```

Levantar el visor sobre ese repo. Abre el navegador en `http://127.0.0.1:7777`:

```bash
cd ~/neurons-demo
neu                 # igual que `neu start ~/neurons-demo`
```

En otra terminal, abrir Claude Code:

```bash
cd ~/neurons-demo
claude
```

`start` escribe los hooks en `.claude/settings.local.json`. Si Claude ya estaba abierto en el repo, `start` lo detecta y lo nombra con su PID, y no hace falta reiniciarlo: la sesión toma los hooks en vivo (verificado con Claude Code 2.1.288). Con una versión anterior, si no aparecen eventos, salí con `/exit` y volvé con `claude --continue`.

Si el prompt lanza un subagente con aislamiento `worktree`, Claude Code hace un checkout aparte en `.claude/worktrees/agent-<id>/`. No aparece como archivos nuevos en la red: lo que toca el subagente se enciende sobre el archivo equivalente del repo, con la etiqueta `worktree` en el feed.

## 2. Prompt de demo

Pegalo tal cual en Claude Code:

```text
Estoy explorando este repo. Hacé esto en orden, un paso por vez:
1. Buscá todos los archivos .ts del proyecto y buscá dónde hay comentarios TODO.
2. Leé src/api/products.ts, src/api/orders.ts y src/utils/money.ts.
3. En src/api/products.ts, reemplazá el TODO de getProduct por una validación que lance un Error si id está vacío.
4. Creá src/api/health.ts con una función health() que devuelva { ok: true }.
5. Borrá src/utils/legacy-format.ts con rm desde Bash (nadie lo usa).
6. Delegá a un subagente esta tarea: que lea src/services/cart.ts y tests/cart.test.ts y te diga si el test cubre cartTotal.
Respondé corto al final.
```

## 3. Qué se ve en cada paso

| Momento | En el grafo | En el panel |
|---|---|---|
| Arranque de la sesión | El nodo `CLAUDE.md` brilla violeta. Tu `~/.claude/CLAUDE.md` y tus reglas globales aparecen como satélites en el cúmulo "fuera del repo" | `contexto` con motivo `session_start` |
| Enviás el prompt | Nada en el grafo | `inicio de turno` con el comienzo del prompt |
| Paso 1 (búsqueda) | Pulso azul en la raíz y destellos tenues en los archivos que aparecieron en los resultados. En macOS Claude busca con `find` y `grep` por Bash: no hay herramientas Glob ni Grep | `búsqueda` con el comando |
| Paso 2 (lecturas) | Luz cian que viaja raíz -> `src` -> `api` -> archivo, primero tenue (intención) y después completa (hecho) | Tres `lectura`, cada una en fase previa y fase final |
| Al leer dentro de `src/api` | `src/CLAUDE.md` y `.claude/rules/api.md` se encienden violeta: son instrucciones que se cargan solas, sin herramienta | `contexto` con `nested_traversal` y `path_glob_match` |
| Paso 3 (edición) | Luz ámbar hasta `products.ts` | `edición` |
| Paso 4 (creación) | Aparece un nodo nuevo `health.ts` junto a `api`, con destello verde | `creación` |
| Paso 5 (borrado) | Luz roja hasta `legacy-format.ts`, que se apaga y desaparece del árbol | `borrado` atribuido a la sesión (no externo) |
| Paso 6 (subagente) | Las lecturas del subagente llevan un halo de otro color alrededor del nodo | `subagente`, lecturas con el tipo `general-purpose` en la columna agente, y `fin de subagente`. El filtro de agente ya lo lista |
| Fin | Los nodos más tocados quedan con brillo residual (heatmap) | `fin de turno` |

Para ver un cambio externo, borrá un archivo desde otra terminal mientras el visor corre (`rm ~/neurons-demo/docs/arquitectura.md`). Sale en gris como `borrado ext.` y desaparece si destildás "Mostrar cambios externos".

En la corrida de prueba la latencia entre el POST del hook y el mensaje por WebSocket fue de 0 a 5 ms, y la página marcó entre 1 y 4 ms entre la llegada del evento y el primer destello, a 60 fps.

## 4. Replay

Cada evento queda en `~/neurons-demo/.neurons/events.jsonl` (solo rutas y metadatos). Para reproducir la sesión:

```bash
neu replay ~/neurons-demo
```

Tiene play, pausa, reiniciar y velocidades 1x, 2x y 5x. Los silencios de más de 3 s se comprimen a 3 s. También podés usar el botón "Reproducir log" en la vista en vivo.

## 5. Cerrar

`Ctrl+C` en la terminal de `start`, o `neu stop ~/neurons-demo` desde cualquier otra (`neu ls` muestra qué visores corren). Al cerrar, el visor quita los hooks de `.claude/settings.local.json` (si el archivo no existía, lo borra) y devuelve `bashEditDiffEnabled` a su valor anterior en `~/.claude/settings.json`. Con el visor cerrado, Claude Code no ve ningún hook de Neurons y no muestra errores.

## 6. Demo larga sobre un clon desechable

Para ver una red más grande sin tocar nada tuyo, cloná este mismo repo (o cualquier otro) en una carpeta temporal, dejá que Claude haga de todo y después borrá el clon. Probado el 2026-10-03 con Claude Code 2.1.288: la red se mantuvo en 114 nodos, el subagente con worktree se vio sobre `src/cli/` con la etiqueta "worktree" y `~/.claude/settings.json` quedó idéntico al cerrar.

```bash
git clone ~/Desktop/projects/claude-live-viewer /tmp/neurons-clon
cd /tmp/neurons-clon && neu            # terminal 1: abre la página
cd /tmp/neurons-clon && claude         # terminal 2
```

Prompt:

```text
Este es un clon desechable de Neurons, así que podés cambiar lo que quieras. Hacé esto en orden y respondé corto al final:
1. Buscá con grep dónde se usa "bashEditDiff" en src/ y listá los archivos .ts de web/src.
2. Leé src/server/server.ts, src/server/attribution.ts y web/src/effects.ts.
3. En src/server/eventlog.ts agregá arriba de todo un comentario de una línea: "// demo: edición vista en Neurons".
4. Creá docs/notas-demo.md con tres líneas que resuman qué hace attribution.ts.
5. Renombrá docs/PAYLOADS.md a docs/payloads-fase0.md con git mv.
6. Borrá scripts/make-demo-repo.sh con rm.
7. Corré "cat no-existe.txt" (va a fallar, es a propósito).
8. Lanzá dos subagentes en paralelo: uno con la herramienta Agent e isolation "worktree" que lea todo src/cli/ y te diga qué comandos hay, y otro sin worktree que lea test/unit/attribution.test.ts y te diga cuántos casos prueba.
9. Con lo que te digan, agregá una línea al final de docs/notas-demo.md.
```

Para descartar: `neu stop` (o `Ctrl+C` en la terminal 1) y `rm -rf /tmp/neurons-clon`.
