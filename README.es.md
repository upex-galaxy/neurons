[English](README.md) · **Español**

# Neurons

Neurons muestra en vivo lo que hace Claude Code dentro de un repositorio. Corrés `neu` en un repo y el navegador se abre con el repositorio dibujado como una red: cada archivo y cada carpeta es un nodo. Cuando Claude Code lee, busca, edita, crea o borra algo, una luz viaja hasta ese archivo con el color de la acción.

![Neurons mostrando su propio repositorio como una red, con el panel de actividad a la derecha](docs/img/live.png)

Sirve para mirar cómo trabaja el agente: qué lee primero, cuánto explora antes de editar, qué instrucciones se cargan solas y qué hacen sus subagentes. Corre en tu máquina y no guarda el contenido de los archivos: guarda rutas, metadatos y los comandos de Bash que corrió Claude, con lo que escriben tapado (un filtro que hace lo que puede, ver la [guía](docs/guide.html#faq-content)).

## Instalalo con tu IA

Abrí Claude Code en cualquier carpeta y pegá este prompt. Reemplazá `<repo-url>` por la dirección de donde sacaste Neurons (una URL de Git o una carpeta de tu disco).

```text
Instalá el CLI de Neurons (paquete npm neurons-cli) en esta máquina. Hacé estos pasos en orden y frená para avisarme si alguno falla.

1. Corré `node --version`. Neurons necesita Node 22.12 o superior. Si el mío es más viejo, frená y decime cómo actualizarlo; no toques mi instalación de Node vos.
2. Cloná el repositorio: `git clone <repo-url> ~/neurons`. Si <repo-url> sigue siendo un marcador, pedímelo. Si ~/neurons ya existe, preguntame antes de tocarlo.
3. En ~/neurons corré `npm install` y después `npm run build`. El build tiene que dejar el archivo ~/neurons/dist/cli.mjs.
4. En ~/neurons corré `npm link`. Eso deja dos comandos globales en mi PATH, `neu` y `neurons`, que son el mismo programa. Si falla con EEXIST porque otro paquete ya es dueño de `neu`, decime qué paquete es y no uses --force sin preguntarme. Si falla con EACCES, explicame las opciones en vez de usar sudo.
5. Revisá la instalación: `neu --version` tiene que mostrar una versión y `neu doctor` tiene que correr. Mostrame lo que dice doctor. Que avise que los hooks no están instalados es normal en este punto.
6. Contame en dos líneas cómo se usa: entrar con cd a cualquier repositorio y correr `neu`, y después abrir Claude Code en ese mismo repositorio.

Si quiero que el comando tenga otro nombre, los nombres salen del campo "bin" de ~/neurons/package.json. Se cambia una clave ahí (por ejemplo "neu" por "nr") y se corre `npm unlink -g neurons-cli` y después `npm link` otra vez. Preguntame si lo quiero antes de cambiar nada.
```

## Instalalo a mano

Necesitás Node 22.12 o superior, git y Claude Code (probado con 2.1.285 y 2.1.288). Neurons todavía no está en npm.

```bash
git clone <repo-url> ~/neurons
cd ~/neurons
npm install
npm run build
npm link            # deja los comandos globales neu y neurons
neu --version
neu doctor
```

Para quitar los comandos: `npm unlink -g neurons-cli`. Para usar otro nombre, cambiá las claves de `"bin"` en `package.json` y volvé a enlazar.

## Usalo

```bash
cd ~/proyectos/mi-repo
neu                 # levanta el visor y abre http://127.0.0.1:7777
```

Después abrí Claude Code en ese repo, en otra terminal, como siempre. Una sesión que ya estaba abierta toma los hooks sin reiniciar (verificado con Claude Code 2.1.288 en macOS). Si no muestra eventos, corré `/reload-plugins` en ella; si no alcanza, `/exit` y después `claude --continue`. `Ctrl+C`, o `neu stop` desde cualquier otra terminal, cierra el visor y quita sus hooks.

| Comando | Qué hace |
|---|---|
| `neu [repo]` | Levanta el visor de ese repo (por defecto, el actual) |
| `neu ls` | Lista los visores que corren, uno por repo, cada uno en su puerto |
| `neu open [repo]` | Vuelve a abrir la página de un visor |
| `neu stop [repo]` | Cierra un visor; `--all` los cierra todos |
| `neu replay [repo]` | Reproduce una sesión grabada |
| `neu doctor [repo]` | Revisa Node, los hooks y la configuración |
| `neu uninstall [repo]` | Quita los hooks que quedaron si un visor murió sin limpiar |
| `neu help` | Todos los comandos y opciones |

Los mensajes de `neu` siguen el idioma del sistema; `--lang es` o `NEURONS_LANG=es` los fuerza en castellano.

## Guía y arquitectura

La [guía de uso](docs/guide.html) cubre la instalación, el uso diario y un FAQ largo: qué significa cada color, sesiones y subagentes, replay, la línea de tiempo, qué toca Neurons en tu máquina, privacidad y cómo hacer una demo sin romper nada. Mientras el visor corre también está en `/help`, en la dirección del visor, en inglés y en castellano.

[Cómo funciona](docs/architecture.html) explica los hooks, el servidor y la página con diagramas animados (`/architecture` con el visor abierto). Las decisiones de diseño y sus motivos están en [docs/DECISIONS.md](docs/DECISIONS.md), y los payloads reales de los hooks en [docs/PAYLOADS.md](docs/PAYLOADS.md).

## Sistemas operativos

Verificado en macOS (Apple Silicon). En Linux debería andar, pero todavía no se corrió. El soporte de Windows es experimental y no está probado; la guía lista [las limitaciones conocidas](docs/guide.html#faq-os).

## Desarrollo

```bash
npm run build        # página web (Vite), CLI (tsdown) y docs en dist/
npm run typecheck
npm test             # build + Vitest (servidor y web) + Playwright
npm run dev -- start ../otro-repo   # CLI desde src con tsx
```

Los textos de las páginas de docs están en `docs/i18n/guide.{en,es}.json` y `docs/i18n/architecture.{en,es}.json`. Después de editarlos, corré `node scripts/sync-guide-i18n.mjs` para que las dos páginas también cambien de idioma abiertas desde el disco.

Si usabas el nombre anterior, repo-synapse: corré `npm unlink -g repo-synapse` antes de `npm link`. Sus hooks y logs viejos se limpian o se reusan solos (decisión I28 en [DECISIONS.md](docs/DECISIONS.md)).

## Licencia

MIT.
