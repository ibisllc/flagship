import { vi } from "vitest";

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  created_on: string;
  modified_on: string;
}

/**
 * An in-memory stand-in for the Cloudflare DNS API (records of one zone),
 * installed as `fetch`, so the real `CloudflareDnsClient` runs against it:
 * list by name/type, create (81058 on an identical record), patch, delete.
 * `afterRequest` lets a test inject a change between two calls of the code
 * under test (a racing registration, a new challenge).
 */
export class FakeCloudflare {
  records: FakeRecord[] = [];
  requests: string[] = [];
  /** Called after each request is served; may mutate `records`. */
  afterRequest?: (method: string, name: string | null) => void;
  private next = 1;

  install(): void {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => this.serve(url, init));
  }

  seed(type: string, name: string, content: string, over: Partial<FakeRecord> = {}): FakeRecord {
    const rec: FakeRecord = {
      id: String(this.next++).padStart(32, "0"),
      type,
      name,
      content,
      proxied: false,
      ttl: 60,
      created_on: "2026-10-01T00:00:00.000Z",
      modified_on: "2026-10-01T00:00:00.000Z",
      ...over,
    };
    this.records.push(rec);
    return rec;
  }

  /** `TYPE name content` lines, sorted: the whole zone at a glance. */
  dump(): string[] {
    return this.records.map((r) => `${r.type} ${r.name} ${r.content}`).sort();
  }

  /** Just `TYPE name`, sorted. */
  names(): string[] {
    return this.records.map((r) => `${r.type} ${r.name}`).sort();
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  private async serve(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const m = u.pathname.match(/\/dns_records(?:\/([^/]+))?$/);
    if (!m) return this.json({ success: false, errors: [{ code: 7003 }] }, 404);
    const id = m[1];
    this.requests.push(`${method} ${u.pathname.split("/zones/")[1] ?? ""}${u.search}`);
    // Let concurrent callers interleave between their list and their create.
    await Promise.resolve();
    let res: Response;
    let touched: string | null = null;
    if (method === "GET" && !id) {
      const name = u.searchParams.get("name");
      const type = u.searchParams.get("type");
      touched = name;
      let rows = this.records.filter((r) => (name ? r.name === name : true) && (type ? r.type === type : true));
      if (!name) {
        const perPage = Number(u.searchParams.get("per_page") ?? 100);
        const page = Number(u.searchParams.get("page") ?? 1);
        const total = Math.max(1, Math.ceil(rows.length / perPage));
        rows = rows.slice((page - 1) * perPage, page * perPage);
        res = this.json({ success: true, result: rows, result_info: { total_pages: total } });
      } else {
        res = this.json({ success: true, result: rows });
      }
    } else if (method === "GET" && id) {
      const r = this.records.find((x) => x.id === id);
      res = r ? this.json({ success: true, result: r }) : this.json({ success: false }, 404);
    } else if (method === "POST") {
      const b = JSON.parse(String(init?.body)) as {
        type: string;
        name: string;
        content?: string;
        data?: { flags: number; tag: string; value: string };
        ttl?: number;
        proxied?: boolean;
      };
      touched = b.name;
      const content = b.type === "CAA" && b.data ? `${b.data.flags} ${b.data.tag} "${b.data.value}"` : String(b.content);
      if (this.records.some((r) => r.type === b.type && r.name === b.name && r.content === content)) {
        res = this.json(
          { success: false, errors: [{ code: 81058, message: "An identical record already exists." }] },
          400,
        );
      } else {
        const rec = this.seed(b.type, b.name, content, { ttl: b.ttl ?? 60, proxied: b.proxied ?? false });
        res = this.json({ success: true, result: rec });
      }
    } else if (method === "PATCH" && id) {
      const r = this.records.find((x) => x.id === id);
      if (!r) res = this.json({ success: false }, 404);
      else {
        const b = JSON.parse(String(init?.body)) as { content?: string; ttl?: number; proxied?: boolean };
        touched = r.name;
        if (b.content !== undefined) r.content = b.content;
        if (b.ttl !== undefined) r.ttl = b.ttl;
        if (b.proxied !== undefined) r.proxied = b.proxied;
        r.modified_on = "2026-10-18T00:00:00.000Z";
        res = this.json({ success: true, result: r });
      }
    } else if (method === "DELETE" && id) {
      const i = this.records.findIndex((x) => x.id === id);
      if (i === -1) res = this.json({ success: false }, 404);
      else {
        touched = this.records[i]!.name;
        this.records.splice(i, 1);
        res = this.json({ success: true });
      }
    } else {
      res = this.json({ success: false }, 405);
    }
    this.afterRequest?.(method, touched);
    return res;
  }
}
