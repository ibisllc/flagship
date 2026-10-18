// Bind values written into SQL text the way SQLite reads a literal, for
// refresh-model-capabilities.ts, which sends statements through `wrangler d1 execute`.
export function inline(sql: string, binds: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = binds[i++];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
    if (typeof v === "boolean") return v ? "1" : "0";
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}
