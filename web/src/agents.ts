// Distinct hue per subagent: golden-angle steps in HSL, in order of first appearance.
import { Color } from 'three';

const GOLDEN_ANGLE = 137.508;
/** Start away from the yellow used by subagent_start/stop. */
const HUE_OFFSET = 200;

const order = new Map<string, number>();
const cache = new Map<string, string>();
const types = new Map<string, string>();

export function agentColor(agentId: string): string {
  const hit = cache.get(agentId);
  if (hit) return hit;
  let i = order.get(agentId);
  if (i === undefined) {
    i = order.size;
    order.set(agentId, i);
  }
  const hue = ((HUE_OFFSET + i * GOLDEN_ANGLE) % 360) / 360;
  const hex = `#${new Color().setHSL(hue, 0.85, 0.62).getHexString()}`;
  cache.set(agentId, hex);
  return hex;
}

export function rememberAgent(agentId: string, agentType?: string): boolean {
  const known = types.has(agentId);
  if (agentType || !known) types.set(agentId, agentType ?? types.get(agentId) ?? '');
  agentColor(agentId);
  return !known;
}

export function agentType(agentId: string): string {
  return types.get(agentId) ?? '';
}

export function knownAgents(): string[] {
  return [...types.keys()];
}

export function shortId(id: string, n = 6): string {
  return id.slice(0, n);
}
