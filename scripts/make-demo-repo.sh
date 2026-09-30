#!/usr/bin/env bash
# Creates the small demo repository used by docs/DEMO.md.
# Usage: scripts/make-demo-repo.sh [target-dir]   (default: ~/repo-synapse-demo)
set -euo pipefail

TARGET="${1:-$HOME/repo-synapse-demo}"
if [ -e "$TARGET" ]; then
  echo "Ya existe: $TARGET (borralo o elegí otra ruta)" >&2
  exit 1
fi

mkdir -p "$TARGET"/{src/api,src/services,src/utils,tests,docs,.claude/rules}
cd "$TARGET"

cat > CLAUDE.md <<'EOF'
# Tienda demo

API mínima de una tienda en TypeScript. Sirve para ver en repo-synapse cómo se mueve Claude Code.

- Código en `src/`, pruebas en `tests/`.
- Los precios se manejan en centavos (`number` entero).
EOF

cat > src/CLAUDE.md <<'EOF'
# Convenciones de src

Usá exports con nombre. Nada de `default export`.
EOF

cat > .claude/rules/api.md <<'EOF'
---
paths:
  - "src/api/**/*.ts"
---
Los handlers de la API validan su entrada antes de usarla.
EOF

cat > src/api/products.ts <<'EOF'
import { formatMoney } from '../utils/money';

const PRODUCTS = [
  { id: 'p1', name: 'Taza', priceCents: 1200 },
  { id: 'p2', name: 'Cuaderno', priceCents: 2500 },
];

export function listProducts() {
  return PRODUCTS.map((p) => ({ ...p, price: formatMoney(p.priceCents) }));
}

export function getProduct(id: string) {
  // TODO: validar id
  return PRODUCTS.find((p) => p.id === id);
}
EOF

cat > src/api/orders.ts <<'EOF'
import { cartTotal } from '../services/cart';

export function createOrder(items: { productId: string; qty: number; priceCents: number }[]) {
  // TODO: validar que qty sea positivo
  return { id: `o-${Date.now()}`, totalCents: cartTotal(items) };
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

cat > src/utils/money.ts <<'EOF'
export function formatMoney(cents: number) {
  // TODO: soportar otras monedas
  return `$${(cents / 100).toFixed(2)}`;
}
EOF

cat > src/utils/dates.ts <<'EOF'
export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
EOF

cat > src/utils/legacy-format.ts <<'EOF'
// Formateador viejo, ya no lo usa nadie.
export function oldFormat(n: number) {
  return '$' + n;
}
EOF

cat > tests/cart.test.ts <<'EOF'
import { cartTotal } from '../src/services/cart';

if (cartTotal([{ qty: 2, priceCents: 100 }]) !== 200) throw new Error('cartTotal');
EOF

cat > docs/arquitectura.md <<'EOF'
# Arquitectura

`api` -> `services` -> `utils`. Sin base de datos: todo en memoria.
EOF

cat > README.md <<'EOF'
# Tienda demo

Repo de ejemplo para repo-synapse.
EOF

cat > package.json <<'EOF'
{ "name": "tienda-demo", "private": true, "type": "module" }
EOF

git init -q
git add -A
git -c user.name=demo -c user.email=demo@example.invalid -c commit.gpgsign=false commit -qm "Tienda demo"
echo "Repo de demo creado en $TARGET ($(git ls-files | wc -l | tr -d ' ') archivos)"
