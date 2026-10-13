export interface OrderResult {
  order: number[];
  /** Issues stuck in (or behind) a dependency cycle; empty when the graph is acyclic. */
  stuck: number[];
}

/**
 * Kahn topological sort. Dependencies on issues outside the set are ignored;
 * whenever several issues are ready, the lowest number goes first.
 */
export function orderIssues(numbers: number[], deps: Map<number, number[]>): OrderResult {
  const nodes = new Set(numbers);
  const blockers = new Map<number, Set<number>>();
  for (const n of nodes) {
    blockers.set(n, new Set((deps.get(n) ?? []).filter((b) => nodes.has(b))));
  }
  const remaining = new Set(nodes);
  const order: number[] = [];
  for (;;) {
    const ready = [...remaining].filter((n) => [...(blockers.get(n) ?? [])].every((b) => !remaining.has(b))).sort((a, b) => a - b);
    const next = ready[0];
    if (next === undefined) break;
    order.push(next);
    remaining.delete(next);
  }
  return { order, stuck: [...remaining].sort((a, b) => a - b) };
}
