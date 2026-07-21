/**
 * Deterministic synthetic-dataset generator.
 *
 * Given a parsed `AppSchema` + a seed, produce a `SyntheticDataset` that
 * preserves the properties the patent claims require (spec §2): foreign-key
 * integrity, uniqueness, enum coverage, NOT-NULL, and boundary values — while
 * representing no real person. Same `(schema, seed)` ⇒ byte-identical output.
 *
 * The PRNG is a SHA-256 counter stream keyed by the seed (no Math.random —
 * that would break determinism and is banned in canonical/reproducible code).
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { parseSchema } from "./schemaParse.js";
import type {
  AppSchema,
  SchemaColumn,
  SchemaTable,
  SemanticType,
  SynthHints,
  SyntheticDataset,
  SynthRow,
} from "./types.js";

const DEFAULT_ROWS = 12;
const DEFAULT_CANARIES = 3;

/** SHA-256 counter-mode PRNG — deterministic, seedable, no global RNG. */
class SeededRng {
  private counter = 0;
  constructor(private readonly key: Uint8Array) {}
  private block(): Uint8Array {
    const ctr = new Uint8Array(8);
    let n = this.counter++;
    for (let i = 0; i < 8; i++) {
      ctr[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    const input = new Uint8Array(this.key.length + ctr.length);
    input.set(this.key);
    input.set(ctr, this.key.length);
    return sha256(input);
  }
  /** Uniform u32. */
  u32(): number {
    const b = this.block();
    return (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0;
  }
  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + (this.u32() % (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    const v = arr[this.u32() % arr.length];
    // arr is always non-empty at call sites; assert for the strict checker.
    return v as T;
  }
  hex(bytes: number): string {
    let out = "";
    while (out.length < bytes * 2) {
      const b = this.block();
      for (const x of b) out += x.toString(16).padStart(2, "0");
    }
    return out.slice(0, bytes * 2);
  }
}

const FIRST_NAMES = ["ada", "grace", "alan", "linus", "hedy", "katherine", "george", "mary", "john", "elena", "omar", "yuki"];
const LAST_NAMES = ["lovelace", "hopper", "turing", "torvalds", "lamarr", "johnson", "boole", "jackson", "chen", "okonkwo", "silva", "novak"];
const CITIES = ["springfield", "riverton", "fairview", "greenville", "franklin", "clinton", "salem", "madison"];
const COUNTRIES = ["Nowherestan", "Republic of Testonia", "Fauxland", "Sampleria", "Mockovia"];
const LOREM = ["lorem ipsum dolor", "sit amet consectetur", "adipiscing elit sed", "do eiusmod tempor", "incididunt ut labore"];
const TITLES = ["Untitled Note", "First Draft", "Meeting Notes", "Ideas", "Shopping List", "Reading List"];

function inferSemantic(col: SchemaColumn): SemanticType | undefined {
  const n = col.name.toLowerCase();
  if (/email/.test(n)) return "email";
  if (/first_?name/.test(n)) return "first_name";
  if (/last_?name|surname/.test(n)) return "last_name";
  if (/(full_?)?name$/.test(n)) return "person_name";
  if (/city/.test(n)) return "city";
  if (/country/.test(n)) return "country";
  if (/phone|mobile|tel/.test(n)) return "phone";
  if (/url|link|website/.test(n)) return "url";
  if (/title|subject|heading/.test(n)) return "title";
  if (/slug/.test(n)) return "slug";
  if (/price|amount|cost|total/.test(n)) return "price";
  if (/count|qty|quantity|num_/.test(n)) return "count";
  if (/body|content|description|text|notes?/.test(n)) return "lorem";
  return undefined;
}

/**
 * Topologically order tables so a table is generated AFTER any table it
 * references — so FK values can point at already-generated PKs. Cycles (rare
 * in vibecode apps) fall back to declaration order.
 */
function orderTables(schema: AppSchema): SchemaTable[] {
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const ordered: SchemaTable[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: SchemaTable): void => {
    if (done.has(t.name) || visiting.has(t.name)) return;
    visiting.add(t.name);
    for (const col of t.columns) {
      const ref = col.references?.table;
      if (ref && ref !== t.name && byName.has(ref)) visit(byName.get(ref)!);
    }
    visiting.delete(t.name);
    done.add(t.name);
    ordered.push(t);
  };
  for (const t of schema.tables) visit(t);
  return ordered;
}

function semanticValue(sem: SemanticType, rng: SeededRng, rowIdx: number): string | number {
  switch (sem) {
    case "email":
      return `${rng.pick(FIRST_NAMES)}.${rng.pick(LAST_NAMES)}${rowIdx}@example.test`;
    case "first_name":
      return rng.pick(FIRST_NAMES);
    case "last_name":
      return rng.pick(LAST_NAMES);
    case "person_name":
      return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
    case "city":
      return rng.pick(CITIES);
    case "country":
      return rng.pick(COUNTRIES);
    case "phone":
      return `+1-555-${String(rng.int(1000, 9999))}`;
    case "url":
      return `https://example.test/${rng.hex(4)}`;
    case "title":
      return rng.pick(TITLES);
    case "slug":
      return `${rng.pick(TITLES).toLowerCase().replace(/\s+/g, "-")}-${rowIdx}`;
    case "price":
      return rng.int(1, 9999) / 100;
    case "count":
      return rng.int(0, 100);
    case "lorem":
    default:
      return `${rng.pick(LOREM)} ${rng.pick(LOREM)}`;
  }
}

/**
 * Generate a column value. `pkCounter` supplies stable, unique integer PKs.
 * Boundary values (0, 1, empty-ish, max) are injected on the first few rows so
 * the synthetic set always exercises edges.
 */
function columnValue(
  col: SchemaColumn,
  rng: SeededRng,
  rowIdx: number,
  pkValue: number,
  fkPool: number[] | undefined,
  canaryFor: ((v: string) => void) | undefined,
): string | number | boolean | null {
  // Primary key: dense unique sequence (works for int and uuid/text PKs).
  if (col.primaryKey) {
    if (col.type === "uuid" || col.type === "text" || col.type === "varchar") {
      return `${col.name}-${pkValue}`;
    }
    return pkValue;
  }
  // Foreign key: pick an existing parent PK (FK integrity). If the parent set
  // is empty and the column is nullable, use NULL; else fall back to 1.
  if (col.references) {
    if (fkPool && fkPool.length) return rng.pick(fkPool);
    return col.notNull ? 1 : null;
  }
  // Enum / CHECK: cover every declared value across the first rows, then random.
  if (col.enumValues && col.enumValues.length) {
    if (rowIdx < col.enumValues.length) return col.enumValues[rowIdx] ?? rng.pick(col.enumValues);
    return rng.pick(col.enumValues);
  }
  // Nullable columns: sprinkle NULLs (but never on row 0, so a non-null example
  // always exists).
  if (!col.notNull && rowIdx > 0 && rng.u32() % 5 === 0) return null;

  const sem = col.semantic ?? inferSemantic(col);
  switch (col.type) {
    case "integer":
    case "bigint": {
      if (rowIdx === 0) return 0; // boundary
      if (rowIdx === 1) return 1; // boundary
      if (sem === "count" || sem === "price") return semanticValue(sem, rng, rowIdx) as number;
      return rng.int(2, 100000);
    }
    case "numeric":
      return rng.int(0, 1000000) / 100;
    case "boolean":
      return rowIdx % 2 === 0;
    case "timestamp":
      // Deterministic, temporally ordered (older rows earlier).
      return isoFromOffset(rowIdx);
    case "date":
      return isoFromOffset(rowIdx).slice(0, 10);
    case "uuid":
      return uuidFrom(rng);
    case "json":
      return `{"k":"${rng.hex(3)}"}`;
    case "text":
    case "varchar":
    default: {
      const v = String(sem ? semanticValue(sem, rng, rowIdx) : `${col.name}-${rng.hex(4)}`);
      if (canaryFor && sem === "lorem" && rowIdx === 0) {
        const token = `FLAGSHIP-CANARY-${rng.hex(6)}`;
        canaryFor(token);
        return `${v} ${token}`;
      }
      return v;
    }
  }
}

/** Fixed epoch base so timestamps are deterministic (no Date.now()). */
const EPOCH_BASE = Date.parse("2024-01-01T00:00:00.000Z");
function isoFromOffset(rowIdx: number): string {
  return new Date(EPOCH_BASE + rowIdx * 86_400_000).toISOString();
}
function uuidFrom(rng: SeededRng): string {
  const h = rng.hex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface GenerateArgs {
  /** Either a parsed schema or raw migration SQL to parse. */
  schema?: AppSchema;
  sql?: string;
  /** Deterministic seed (hex). Same seed + schema ⇒ identical dataset. */
  seedHex: string;
  hints?: SynthHints;
}

/**
 * Generate a synthetic dataset. Pure + deterministic.
 */
export function generateSynthetic(args: GenerateArgs): SyntheticDataset {
  const schema = args.schema ?? parseSchema(args.sql ?? "");
  const seedBytes = hexToBytes(args.seedHex);
  const canaries: string[] = [];
  const canaryBudget = args.hints?.canaryCount ?? DEFAULT_CANARIES;

  const ordered = orderTables(schema);
  const pkPools = new Map<string, number[]>(); // table → generated PK values
  const pg: SyntheticDataset["pg"] = [];

  for (const table of ordered) {
    // Per-table PRNG stream so adding a table doesn't shift other tables' data.
    const tableKey = hkdf(sha256, seedBytes, new TextEncoder().encode("flagship.synth.table.v1"), new TextEncoder().encode(table.name), 32);
    const rng = new SeededRng(tableKey);
    const rowCount = args.hints?.rowCounts?.[table.name] ?? DEFAULT_ROWS;

    const pkCol = table.columns.find((c) => c.primaryKey);
    const myPks: number[] = [];
    const columns = table.columns.map((c) => c.name);
    const rows: SynthRow[] = [];
    // Track uniqueness per unique column.
    const seen = new Map<string, Set<string>>();
    for (const c of table.columns) if (c.unique) seen.set(c.name, new Set());

    for (let i = 0; i < rowCount; i++) {
      const pkValue = i + 1;
      const row: SynthRow = {};
      for (const col of table.columns) {
        const fkPool = col.references ? pkPools.get(col.references.table) : undefined;
        let value = columnValue(
          col,
          rng,
          i,
          pkValue,
          fkPool,
          canaries.length < canaryBudget ? (t) => canaries.push(t) : undefined,
        );
        // Enforce uniqueness: on collision, suffix a deterministic disambiguator.
        if (col.unique && value !== null) {
          const set = seen.get(col.name)!;
          let key = String(value);
          let attempt = 0;
          while (set.has(key)) {
            attempt++;
            if (typeof value === "number") {
              value = value + attempt * 100000;
            } else {
              value = `${String(value)}-${attempt}`;
            }
            key = String(value);
          }
          set.add(key);
        }
        row[col.name] = value;
      }
      rows.push(row);
      if (pkCol) myPks.push(pkValue);
    }
    if (pkCol) pkPools.set(table.name, myPks);
    pg.push({ table: table.name, columns, rows });
  }

  return { seedHex: args.seedHex, pg, canaries };
}

/** Render a dataset as an idempotent SQL seed script (INSERTs, FK-safe order). */
export function datasetToSql(ds: SyntheticDataset): string {
  const lines: string[] = ["-- Synthetic dev dataset (generated; represents no real person).", `-- seed=${ds.seedHex}`];
  for (const t of ds.pg) {
    for (const row of t.rows) {
      const cols = t.columns.filter((c) => row[c] !== undefined);
      const vals = cols.map((c) => sqlLiteral(row[c] ?? null));
      lines.push(`INSERT INTO "${t.table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.join(", ")});`);
    }
  }
  return lines.join("\n") + "\n";
}

function sqlLiteral(v: string | number | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${v.replace(/'/g, "''")}'`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
