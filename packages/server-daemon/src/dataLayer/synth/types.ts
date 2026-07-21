/**
 * Types for the synthetic dev-dataspace synthesizer.
 *
 * The synthesizer turns an app's DECLARED SCHEMA into a fabricated dataset
 * that is statistically plausible but represents no real person. It NEVER
 * reads production rows — the "author is blind to prod" invariant is trivially
 * true because prod data is not an input here (see
 * `docs/dev-prod-dataspace-harness-spec.md` §2).
 *
 * Determinism: given the same `(schema, seed)` the generated dataset is
 * byte-identical. The seed is recorded in the build evidence bundle so a dev
 * dataspace can be re-minted exactly (claim-support artifact + reproducible
 * dev runs).
 */

/** A parsed column from the app's first-turn migration DDL. */
export interface SchemaColumn {
  name: string;
  /** Normalised SQL type family we know how to synthesize. */
  type: ColumnType;
  /** Raw declared type string, kept for diagnostics / round-trip. */
  rawType: string;
  notNull: boolean;
  unique: boolean;
  primaryKey: boolean;
  /** Present when this column is a FK: the referenced table + column. */
  references?: { table: string; column: string };
  /** Allowed values when the column is an enum / CHECK (... IN (...)). */
  enumValues?: string[];
  /**
   * Semantic hint used to pick a realistic generator (email, name, city, …).
   * Sourced from the manifest `data.synth` block or inferred from the column
   * name; falls back to the raw type family.
   */
  semantic?: SemanticType;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}

export interface AppSchema {
  tables: SchemaTable[];
}

/** SQL type families the generator understands. */
export type ColumnType =
  | "integer"
  | "bigint"
  | "text"
  | "varchar"
  | "boolean"
  | "timestamp"
  | "date"
  | "uuid"
  | "numeric"
  | "json"
  | "unknown";

/** Semantic generators — chosen by hint or name inference. */
export type SemanticType =
  | "email"
  | "person_name"
  | "first_name"
  | "last_name"
  | "city"
  | "country"
  | "phone"
  | "url"
  | "lorem"
  | "title"
  | "slug"
  | "price"
  | "count";

/** Optional per-app synthesis hints from the manifest `data.synth` block. */
export interface SynthHints {
  /** Rows to generate per table (default applied when absent). */
  rowCounts?: Record<string, number>;
  /** Per `<table>.<column>` semantic type override. */
  semantics?: Record<string, SemanticType>;
  /** Canary tokens to embed (for egress detection downstream, spec §6). */
  canaryCount?: number;
}

/** A generated row: column name → SQL literal-ready JS value. */
export type SynthRow = Record<string, string | number | boolean | null>;

/** The generated dataset for one app, one dev dataspace. */
export interface SyntheticDataset {
  /** Deterministic seed (hex) this dataset was generated from. */
  seedHex: string;
  /** Postgres seed: ordered INSERT-ready rows per table (FK-safe order). */
  pg: Array<{ table: string; columns: string[]; rows: SynthRow[] }>;
  /** Canary tokens embedded in the set (value → where), for §6 leak checks. */
  canaries: string[];
}
