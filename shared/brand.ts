/**
 * Every value that crosses the wire with identity (signals, objects, functions,
 * promises) is reconstructed on the receiving side as a `Proxy` (or callable
 * proxy / Signal / Promise) that carries a hidden brand. When that value is
 * later passed *back* to the owning peer, the serializer detects the brand and
 * emits `{@H: id}` — "forward this to the thing you already know" — instead of
 * cloning it. This is what preserves round-trip identity automatically.
 *
 * Registered (Symbol.for) so brands remain equal across bundle boundaries.
 * The symbol is intentionally public; forging one only lets you fool your own
 * peer, which you could do via any string anyway.
 */
export const BRAND_REMOTE: unique symbol = Symbol.for(
  'mixed-signals.remote',
) as unknown as typeof BRAND_REMOTE;

export type HandleKind = 's' | 'o' | 'f' | 'p';

export interface RemoteBrand {
  /** Wire id, e.g. "o17". First char is the kind. */
  id: string;
  /** Handle kind, duplicated from `id[0]` for convenience. */
  kind: HandleKind;
  /** Optional class/model name — populated for class-like objects. */
  typeName?: string;
  /** Which peer owns this handle. */
  owner: 'server' | 'client';
}

export function getBrand(value: unknown): RemoteBrand | undefined {
  if (value == null) return undefined;
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return undefined;
  return (value as any)[BRAND_REMOTE];
}

export function brandKindFromId(id: string): HandleKind {
  return id[0] as HandleKind;
}

/** Introspection helper: returns the class/model name of a remote proxy. */
export function typeOfRemote(value: unknown): string | undefined {
  return getBrand(value)?.typeName;
}
