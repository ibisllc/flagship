// The outbound proxy's fallback lane (docs/outbound-proxy.md "Failure
// handling"; migration 0155): the newest owner-signed proxy order an app left
// for a server it couldn't reach, and the server's report that its proxy
// fails. `.com` only relays: the box verifies the order itself.

export type ProxyAlertState = "failing" | "fallback";

export interface BoxProxyLaneOrder {
  orderJson: string;
  signatureHex: string;
  issuedAt: number;
}

export interface BoxProxyAlert {
  serverDomain: string;
  state: ProxyAlertState;
  code: string;
  since: number;
  at: number;
}

export interface BoxProxyLaneStorage {
  /** Keep `order` unless a newer one is held. False when it isn't newer. */
  putOrderIfNewer(serverDomain: string, username: string, order: BoxProxyLaneOrder): Promise<boolean>;
  getOrder(serverDomain: string): Promise<BoxProxyLaneOrder | null>;
  /** Set (or with null clear) the server's alert; returns the alert it replaced. */
  setAlert(serverDomain: string, username: string, alert: Omit<BoxProxyAlert, "serverDomain"> | null): Promise<BoxProxyAlert | null>;
  alertsForUser(username: string): Promise<BoxProxyAlert[]>;
}

interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
}

interface AlertRow {
  server_domain: string;
  alert_state: string | null;
  alert_code: string | null;
  alert_since: number | null;
  alert_at: number | null;
}

function alertOf(r: AlertRow | null): BoxProxyAlert | null {
  if (!r || (r.alert_state !== "failing" && r.alert_state !== "fallback")) return null;
  return {
    serverDomain: r.server_domain,
    state: r.alert_state,
    code: r.alert_code ?? "unreachable",
    since: Number(r.alert_since ?? 0),
    at: Number(r.alert_at ?? 0),
  };
}

export class D1BoxProxyLaneStorage implements BoxProxyLaneStorage {
  constructor(private readonly db: D1Like) {}

  async putOrderIfNewer(serverDomain: string, username: string, o: BoxProxyLaneOrder) {
    const r = (await this.db
      .prepare(
        `INSERT INTO box_proxy_lane (server_domain, username, order_json, signature_hex, issued_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(server_domain) DO UPDATE SET username = excluded.username, order_json = excluded.order_json,
           signature_hex = excluded.signature_hex, issued_at = excluded.issued_at
         WHERE box_proxy_lane.issued_at IS NULL OR box_proxy_lane.issued_at < excluded.issued_at`,
      )
      .bind(serverDomain, username, o.orderJson, o.signatureHex, o.issuedAt)
      .run()) as { meta?: { changes?: number } };
    return (r?.meta?.changes ?? 1) > 0;
  }

  async getOrder(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT order_json, signature_hex, issued_at FROM box_proxy_lane WHERE server_domain = ?1")
      .bind(serverDomain)
      .first<{ order_json: string | null; signature_hex: string | null; issued_at: number | null }>();
    if (!r?.order_json || !r.signature_hex || r.issued_at === null) return null;
    return { orderJson: r.order_json, signatureHex: r.signature_hex, issuedAt: Number(r.issued_at) };
  }

  async setAlert(serverDomain: string, username: string, a: Omit<BoxProxyAlert, "serverDomain"> | null) {
    const prev = alertOf(
      await this.db
        .prepare("SELECT server_domain, alert_state, alert_code, alert_since, alert_at FROM box_proxy_lane WHERE server_domain = ?1")
        .bind(serverDomain)
        .first<AlertRow>(),
    );
    await this.db
      .prepare(
        `INSERT INTO box_proxy_lane (server_domain, username, alert_state, alert_code, alert_since, alert_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(server_domain) DO UPDATE SET username = excluded.username, alert_state = excluded.alert_state,
           alert_code = excluded.alert_code, alert_since = excluded.alert_since, alert_at = excluded.alert_at`,
      )
      .bind(serverDomain, username, a?.state ?? null, a?.code ?? null, a?.since ?? null, a?.at ?? null)
      .run();
    return prev;
  }

  async alertsForUser(username: string) {
    const rows = await this.db
      .prepare(
        "SELECT server_domain, alert_state, alert_code, alert_since, alert_at FROM box_proxy_lane WHERE username = ?1 AND alert_state IS NOT NULL",
      )
      .bind(username)
      .all<AlertRow>();
    return (rows.results ?? []).map(alertOf).filter((a): a is BoxProxyAlert => a !== null);
  }
}

export class InMemoryBoxProxyLaneStorage implements BoxProxyLaneStorage {
  private rows = new Map<string, { username: string; order: BoxProxyLaneOrder | null; alert: BoxProxyAlert | null }>();

  private row(d: string, u: string) {
    let r = this.rows.get(d);
    if (!r) {
      r = { username: u, order: null, alert: null };
      this.rows.set(d, r);
    }
    r.username = u;
    return r;
  }

  async putOrderIfNewer(serverDomain: string, username: string, o: BoxProxyLaneOrder) {
    const r = this.row(serverDomain, username);
    if (r.order && r.order.issuedAt >= o.issuedAt) return false;
    r.order = { ...o };
    return true;
  }

  async getOrder(serverDomain: string) {
    return this.rows.get(serverDomain)?.order ?? null;
  }

  async setAlert(serverDomain: string, username: string, a: Omit<BoxProxyAlert, "serverDomain"> | null) {
    const r = this.row(serverDomain, username);
    const prev = r.alert;
    r.alert = a ? { serverDomain, ...a } : null;
    return prev;
  }

  async alertsForUser(username: string) {
    return [...this.rows.values()].filter((r) => r.username === username && r.alert).map((r) => r.alert!);
  }
}
