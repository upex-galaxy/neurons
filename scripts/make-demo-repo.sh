#!/usr/bin/env bash
# Creates the small demo repository used in the guide (docs/guide.html#faq-demo-small).
# Usage: scripts/make-demo-repo.sh [target-dir]   (default: ~/neurons-demo)
#
# Language of the messages and of the demo files, like the CLI: NEURONS_LANG, then the
# first of LC_ALL / LC_MESSAGES / LANG that is set; Spanish if it starts with "es",
# English otherwise. File names are the same in both languages, so the guide's prompts
# work either way.
set -euo pipefail

demo_lang() {
  local v
  v="$(printf '%s' "${NEURONS_LANG:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$v" in
    es*) echo es; return ;;
    en*) echo en; return ;;
  esac
  for v in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    v="$(printf '%s' "$v" | tr -d '[:space:]')"
    if [ -n "$v" ]; then
      case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
        es*) echo es ;;
        *) echo en ;;
      esac
      return
    fi
  done
  echo en
}
L="$(demo_lang)"

# msg <key> [args...]: prints the message for the chosen language (printf format).
msg() {
  local key="$1"; shift
  local fmt
  case "$L:$key" in
    es:exists) fmt='Ya existe: %s (borralo o elegí otra ruta)' ;;
    en:exists) fmt='Already exists: %s (delete it or pick another path)' ;;
    es:created) fmt='Repo de demo creado en %s (%s archivos)' ;;
    en:created) fmt='Demo repo created in %s (%s files)' ;;
  esac
  # shellcheck disable=SC2059
  printf "$fmt\n" "$@"
}

# pick <english> <spanish>: the text for the chosen language.
pick() { if [ "$L" = es ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }

TARGET="${1:-$HOME/neurons-demo}"
if [ -e "$TARGET" ]; then
  msg exists "$TARGET" >&2
  exit 1
fi

mkdir -p "$TARGET"/{src/api,src/services,src/utils,tests,docs,.claude/rules}
cd "$TARGET"

pick "# Demo shop

Minimal shop API in TypeScript, for watching how Claude Code moves in Neurons.

- Code in \`src/\`, tests in \`tests/\`.
- Prices are kept in cents (an integer \`number\`)." "# Tienda demo

API mínima de una tienda en TypeScript. Sirve para ver en Neurons cómo se mueve Claude Code.

- Código en \`src/\`, pruebas en \`tests/\`.
- Los precios se manejan en centavos (\`number\` entero)." > CLAUDE.md

pick "# src conventions

Use named exports. No \`default export\`." "# Convenciones de src

Usá exports con nombre. Nada de \`default export\`." > src/CLAUDE.md

{
  printf '%s\n' '---' 'paths:' '  - "src/api/**/*.ts"' '---'
  pick "API handlers validate their input before using it." "Los handlers de la API validan su entrada antes de usarla."
} > .claude/rules/api.md

cat > src/api/products.ts <<EOF
import { formatMoney } from '../utils/money';

const PRODUCTS = [
  { id: 'p1', name: '$(pick Mug Taza)', priceCents: 1200 },
  { id: 'p2', name: '$(pick Notebook Cuaderno)', priceCents: 2500 },
];

export function listProducts() {
  return PRODUCTS.map((p) => ({ ...p, price: formatMoney(p.priceCents) }));
}

export function getProduct(id: string) {
  // TODO: $(pick "validate id" "validar id")
  return PRODUCTS.find((p) => p.id === id);
}
EOF

cat > src/api/orders.ts <<EOF
import { cartTotal } from '../services/cart';

export function createOrder(items: { productId: string; qty: number; priceCents: number }[]) {
  // TODO: $(pick "check that qty is positive" "validar que qty sea positivo")
  return { id: \`o-\${Date.now()}\`, totalCents: cartTotal(items) };
}
EOF

cat > src/api/users.ts <<'EOF'
export function getUser(id: string) {
  return { id, name: 'Ada' };
}
EOF

cat > src/services/cart.ts <<'EOF'
export function cartTotal(items: { qty: number; priceCents: number }[]) {
  return items.reduce((sum, i) => sum + i.qty * i.priceCents, 0);
}
EOF

cat > src/utils/money.ts <<EOF
export function formatMoney(cents: number) {
  // TODO: $(pick "support other currencies" "soportar otras monedas")
  return \`\$\${(cents / 100).toFixed(2)}\`;
}
EOF

cat > src/utils/dates.ts <<'EOF'
export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
EOF

cat > src/utils/legacy-format.ts <<EOF
// $(pick "Old formatter, nothing uses it anymore." "Formateador viejo, ya no lo usa nadie.")
export function oldFormat(n: number) {
  return '\$' + n;
}
EOF

cat > tests/cart.test.ts <<'EOF'
import { cartTotal } from '../src/services/cart';

if (cartTotal([{ qty: 2, priceCents: 100 }]) !== 200) throw new Error('cartTotal');
EOF

pick "# Architecture

\`api\` -> \`services\` -> \`utils\`. No database: everything lives in memory." "# Arquitectura

\`api\` -> \`services\` -> \`utils\`. Sin base de datos: todo en memoria." > docs/architecture.md

pick "# Demo shop

Sample repo for Neurons." "# Tienda demo

Repo de ejemplo para Neurons." > README.md

cat > package.json <<EOF
{ "name": "$(pick demo-shop tienda-demo)", "private": true, "type": "module" }
EOF

git init -q
git add -A
git -c user.name=demo -c user.email=demo@example.invalid -c commit.gpgsign=false commit -qm "$(pick "Demo shop" "Tienda demo")"
msg created "$TARGET" "$(git ls-files | wc -l | tr -d ' ')"
