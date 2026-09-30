# Guion de demo

Probado el 2026-09-30 con Claude Code 2.1.285 en macOS, sobre el repo que genera `scripts/make-demo-repo.sh`. Los tiempos y conteos de abajo son de esa corrida.

## 1. Instalar, iniciar y abrir la vista

Desde este repo, una sola vez:

```bash
npm install
npm run build
npm link            # deja el comando global `repo-synapse`
```

Crear el repo de ejemplo (14 archivos, con `CLAUDE.md`, `src/CLAUDE.md` y una regla en `.claude/rules/api.md`):

```bash
scripts/make-demo-repo.sh ~/repo-synapse-demo
```

Levantar el visor sobre ese repo. Abre el navegador en `http://127.0.0.1:7777`:

```bash
repo-synapse start ~/repo-synapse-demo
```

En otra terminal, abrir Claude Code **después** de arrancar el visor:

```bash
cd ~/repo-synapse-demo
claude
```

El orden importa: `start` escribe los hooks en `.claude/settings.local.json` y Claude Code los lee al iniciar la sesión. Si Claude ya estaba abierto, reinicialo.

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

Para ver un cambio externo, borrá un archivo desde otra terminal mientras el visor corre (`rm ~/repo-synapse-demo/docs/arquitectura.md`). Sale en gris como `borrado ext.` y desaparece si destildás "Mostrar cambios externos".

En la corrida de prueba la latencia entre el POST del hook y el mensaje por WebSocket fue de 0 a 5 ms, y la página marcó entre 1 y 4 ms entre la llegada del evento y el primer destello, a 60 fps.

## 4. Replay

Cada evento queda en `~/repo-synapse-demo/.repo-synapse/events.jsonl` (solo rutas y metadatos). Para reproducir la sesión:

```bash
repo-synapse replay ~/repo-synapse-demo
```

Tiene play, pausa, reiniciar y velocidades 1x, 2x y 5x. Los silencios de más de 3 s se comprimen a 3 s. También podés usar el botón "Reproducir log" en la vista en vivo.

## 5. Cerrar

`Ctrl+C` en la terminal de `start`. Quita los hooks de `.claude/settings.local.json` (si el archivo no existía, lo borra) y devuelve `bashEditDiffEnabled` a su valor anterior en `~/.claude/settings.json`. Con el visor cerrado, Claude Code no ve ningún hook de repo-synapse y no muestra errores.
