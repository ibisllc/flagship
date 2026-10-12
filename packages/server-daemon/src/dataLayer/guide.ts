/**
 * How an app stores things on a Flagship box, for the AI that writes it: the
 * same lines go into the IDE contract (`buildmodes/contract.ts`), the chat
 * system prompt (`llm/systemPrompt.ts`) and the adapter agent's prompt
 * (`buildmodes/buildAgent.ts`). The box runs Postgres and gives each app one
 * files folder; there is no S3, no Redis, no other database.
 */

import { APP_PG_EXTENSIONS, FILES_MOUNT } from "./naming.js";

/** One line per need: what to use for it. */
export const DATA_RECIPES: ReadonlyArray<{ need: string; how: string }> = [
  {
    need: "Files and uploads",
    how:
      `declare data.stores.files: true and write them under FLAGSHIP_FILES_DIR (${FILES_MOUNT}), named by a generated id ` +
      "(never the user's file name as a path). Keep a metadata table (id, name, size, content_type, created_at) in " +
      "Postgres for listings, and serve each file through the app's own route, streaming it with its Content-Type.",
  },
  {
    need: "Cache",
    how: "an UNLOGGED table (key text primary key, value jsonb, expires_at timestamptz) that ignores and deletes expired rows, or the app's own memory.",
  },
  {
    need: "Pub/sub",
    how: "LISTEN/NOTIFY on a dedicated connection that re-LISTENs after reconnecting; payloads are at most 8000 bytes, so send ids, not data.",
  },
  {
    need: "Job queue",
    how: "a jobs table; a worker takes one with SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1 inside a transaction.",
  },
  {
    need: "Sessions and counters",
    how: "ordinary tables (INSERT ... ON CONFLICT DO UPDATE, UPDATE ... SET n = n + 1).",
  },
  {
    need: "Search",
    how: "tsvector full-text search (to_tsvector, a GIN index) or pg_trgm for fuzzy and partial matches.",
  },
  {
    need: "Embeddings",
    how: "a vector(N) column (pgvector) with an HNSW index, queried with <=> or <->.",
  },
  {
    need: "Scheduled work",
    how: "a timer in the app (setInterval or the language's equivalent); there is no pg_cron.",
  },
];

/** The storage rules plus the recipes, as markdown bullets. */
export function dataRecipesMarkdown(): string {
  return [
    `- Persistent state lives in Postgres (data.stores.postgres: FLAGSHIP_PG_URL) and, for files, the app's one folder (data.stores.files: FLAGSHIP_FILES_DIR=${FILES_MOUNT}). There is no S3, no Redis and no other database: don't add one, and don't put SQLite in the folder.`,
    ...DATA_RECIPES.map((r) => `- ${r.need}: ${r.how}`),
    `- Postgres extensions already installed in every database (CREATE EXTENSION IF NOT EXISTS on them is a harmless no-op): ${APP_PG_EXTENSIONS.join(", ")}. The app may CREATE EXTENSION another trusted contrib one (e.g. "uuid-ossp", tablefunc); one that needs a superuser (dblink, pg_stat_statements, pg_cron, untrusted languages) is refused.`,
  ].join("\n");
}
