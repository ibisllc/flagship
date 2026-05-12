/**
 * UUID v4 generation via Node's built-in crypto.randomUUID(). Keeps the CLI
 * dep-free; available since Node 16.
 */
import { randomUUID } from "node:crypto";

export function newUuid(): string {
  return randomUUID();
}
