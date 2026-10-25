/**
 * The start order of an app group (manifest v2 `components`,
 * docs/app-groups.md): every component after the ones it names in
 * `startAfter`, in declared order where nothing orders them, and the app's
 * own (routed) process last, because it is the one visitors reach. Stops run
 * the other way round.
 */
export interface OrderedComponent {
  name: string;
  startAfter: readonly string[];
}

/** Component names in start order. Throws on a cycle or an unknown name (the manifest parser refuses both first). */
export function componentStartOrder(components: readonly OrderedComponent[]): string[] {
  const names = new Set(components.map((c) => c.name));
  const done = new Set<string>();
  const order: string[] = [];
  const remaining = [...components];
  while (remaining.length > 0) {
    const i = remaining.findIndex((c) => c.startAfter.every((a) => {
      if (!names.has(a)) throw new Error(`component ${c.name} starts after ${a}, which is not a component`);
      return done.has(a);
    }));
    if (i < 0) throw new Error("components' startAfter order has a cycle");
    const [next] = remaining.splice(i, 1);
    done.add(next!.name);
    order.push(next!.name);
  }
  return order;
}
