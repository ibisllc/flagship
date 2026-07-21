/**
 * Synthetic dev-dataspace synthesizer — public surface.
 *
 * Turns an app's declared schema into a deterministic, relationship-preserving
 * fake dataset for the dev dataspace. Never reads production data. See
 * `docs/dev-prod-dataspace-harness-spec.md` §2.
 */
export { parseSchema } from "./schemaParse.js";
export { generateSynthetic, datasetToSql } from "./generate.js";
export type {
  AppSchema,
  SchemaTable,
  SchemaColumn,
  ColumnType,
  SemanticType,
  SynthHints,
  SynthRow,
  SyntheticDataset,
} from "./types.js";
