/**
 * Records every PhoneOrder the pod-sim received so test assertions
 * can read them back. Append-only; tests reset by spinning up a
 * fresh pod-sim per worker.
 */

export interface RecordedOrder {
  type: string;
  raw: unknown;
  receivedAt: number;
}

export class OrdersStore {
  private rows: RecordedOrder[] = [];

  push(order: RecordedOrder): void {
    this.rows.push(order);
  }

  list(): RecordedOrder[] {
    return [...this.rows];
  }

  filterByType(type: string): RecordedOrder[] {
    return this.rows.filter((r) => r.type === type);
  }

  reset(): void {
    this.rows = [];
  }
}
