/**
 * Minimal Postgres DDL parser for the synthesizer.
 *
 * Scope: the `CREATE TABLE` subset the vibecode model emits in its first-turn
 * migration (`migrations/0001_init.sql`). We parse table + column names, a
 * normalised type family, and the constraints that matter for
 * relationship-preserving synthesis: PRIMARY KEY, NOT NULL, UNIQUE, REFERENCES
 * (inline + table-level FK), and CHECK (col IN (...)) enums.
 *
 * This is deliberately NOT a full SQL grammar — it tolerates what the model
 * writes and ignores the rest (indexes, triggers, functions). Anything it
 * cannot classify becomes `type: "unknown"` and the generator falls back to a
 * safe NULL / short-text value; it never throws on unfamiliar DDL.
 */
import type { AppSchema, ColumnType, SchemaColumn, SchemaTable } from "./types.js";

function normaliseType(raw: string): ColumnType {
  const t = raw.toLowerCase().trim();
  if (/^(serial|bigserial|smallserial)/.test(t)) return t.startsWith("big") ? "bigint" : "integer";
  if (/^(int|integer|int4|smallint|int2)/.test(t)) return "integer";
  if (/^(bigint|int8)/.test(t)) return "bigint";
  if (/^(text)/.test(t)) return "text";
  if (/^(varchar|character varying|char)/.test(t)) return "varchar";
  if (/^(bool|boolean)/.test(t)) return "boolean";
  if (/^(timestamptz|timestamp|datetime)/.test(t)) return "timestamp";
  if (/^(date)/.test(t)) return "date";
  if (/^(uuid)/.test(t)) return "uuid";
  if (/^(numeric|decimal|real|double|float|money)/.test(t)) return "numeric";
  if (/^(json|jsonb)/.test(t)) return "json";
  return "unknown";
}

/** Strip SQL line/block comments so they don't confuse the splitter. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Split the parenthesised column list on top-level commas only. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function unquote(id: string): string {
  return id.replace(/^["'`]|["'`]$/g, "");
}

function parseEnumFromCheck(clause: string): string[] | undefined {
  // CHECK (status IN ('a','b','c'))
  const m = /in\s*\(([^)]*)\)/i.exec(clause);
  if (!m || m[1] === undefined) return undefined;
  const vals = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter((s) => s.length > 0);
  return vals.length ? vals : undefined;
}

function parseColumn(line: string): SchemaColumn | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Table-level constraint lines are handled by the caller; skip here.
  if (/^(primary\s+key|foreign\s+key|unique|constraint|check)\b/i.test(trimmed)) return null;

  const nameMatch = /^("?[\w-]+"?|`[\w-]+`)\s+(.+)$/.exec(trimmed);
  if (!nameMatch || nameMatch[1] === undefined || nameMatch[2] === undefined) return null;
  const name = unquote(nameMatch[1]);
  const rest = nameMatch[2];
  const rawType = (/^([a-zA-Z_ ]+(?:\([^)]*\))?)/.exec(rest)?.[1] ?? rest).trim();

  const col: SchemaColumn = {
    name,
    type: normaliseType(rawType),
    rawType,
    notNull: /\bnot\s+null\b/i.test(rest) || /\bprimary\s+key\b/i.test(rest),
    unique: /\bunique\b/i.test(rest) || /\bprimary\s+key\b/i.test(rest),
    primaryKey: /\bprimary\s+key\b/i.test(rest),
  };

  const refMatch = /references\s+("?[\w-]+"?)\s*(?:\(\s*("?[\w-]+"?)\s*\))?/i.exec(rest);
  if (refMatch && refMatch[1] !== undefined) {
    col.references = {
      table: unquote(refMatch[1]),
      column: refMatch[2] ? unquote(refMatch[2]) : "id",
    };
  }
  const enumVals = parseEnumFromCheck(rest);
  if (enumVals) col.enumValues = enumVals;

  return col;
}

/**
 * Parse a migration SQL string into an AppSchema. Never throws on malformed
 * input — unparseable statements are skipped.
 */
export function parseSchema(sql: string): AppSchema {
  const clean = stripComments(sql);
  const tables: SchemaTable[] = [];
  // Match `CREATE TABLE [IF NOT EXISTS] name ( ... );`
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?("?[\w.-]+"?)\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    if (m[1] === undefined || m[2] === undefined) continue;
    const tableName = unquote(m[1]).replace(/^[\w]+\./, ""); // drop schema qualifier
    const body = m[2];
    const parts = splitTopLevel(body);
    const columns: SchemaColumn[] = [];
    const tableLevelPk: string[] = [];
    const tableLevelUnique: string[] = [];
    const tableLevelFk: Array<{ column: string; table: string; refColumn: string }> = [];

    for (const part of parts) {
      const clause = part.trim();
      const pkMatch = /^primary\s+key\s*\(([^)]*)\)/i.exec(clause);
      if (pkMatch && pkMatch[1] !== undefined) {
        pkMatch[1].split(",").forEach((c) => tableLevelPk.push(unquote(c.trim())));
        continue;
      }
      const uniqMatch = /^unique\s*\(([^)]*)\)/i.exec(clause);
      if (uniqMatch && uniqMatch[1] !== undefined) {
        uniqMatch[1].split(",").forEach((c) => tableLevelUnique.push(unquote(c.trim())));
        continue;
      }
      const fkMatch = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+("?[\w-]+"?)\s*(?:\(\s*("?[\w-]+"?)\s*\))?/i.exec(clause);
      if (fkMatch && fkMatch[1] !== undefined && fkMatch[2] !== undefined) {
        tableLevelFk.push({
          column: unquote(fkMatch[1].trim()),
          table: unquote(fkMatch[2]),
          refColumn: fkMatch[3] ? unquote(fkMatch[3]) : "id",
        });
        continue;
      }
      const col = parseColumn(part);
      if (col) columns.push(col);
    }

    // Apply table-level constraints back onto the columns.
    for (const col of columns) {
      if (tableLevelPk.includes(col.name)) {
        col.primaryKey = true;
        col.notNull = true;
        col.unique = true;
      }
      if (tableLevelUnique.includes(col.name)) col.unique = true;
      const fk = tableLevelFk.find((f) => f.column === col.name);
      if (fk && !col.references) col.references = { table: fk.table, column: fk.refColumn };
    }

    if (columns.length) tables.push({ name: tableName, columns });
  }
  return { tables };
}
