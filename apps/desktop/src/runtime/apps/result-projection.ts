// Projection policies are local configuration, never supplied by MCP tool metadata.
// Owns: policy validation and the allowlist copy. Never: logs, writes or emits any result.
import type { McpCallResult } from './types.ts';

type Scalar = string | number | boolean | null;
export type ProjectedRow = Record<string, Scalar>;
export interface ResultProjection { rowsField: string; fields: readonly string[] }
export type ResultProjections = ReadonlyMap<string, ResultProjection>;

const fieldName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(s) &&
  s !== '__proto__' && s !== 'constructor' && s !== 'prototype';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_ROWS = 10_000;
const MAX_CELL = 16_384;
const MAX_BYTES = 2 * 1024 * 1024;

/** null means explicitly configured but invalid; never fall back to raw output. */
export function parseResultProjections(value: unknown): ResultProjections | null {
  if (!record(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 500) return null;
  const policies = new Map<string, ResultProjection>();
  for (const [tool, spec] of entries) {
    if (!tool || tool.length > 256 || !record(spec) || Object.keys(spec).length !== 2 ||
        !Object.hasOwn(spec, 'rowsField') || !fieldName(spec.rowsField) || !Object.hasOwn(spec, 'fields') ||
        !Array.isArray(spec.fields) || !spec.fields.length || spec.fields.length > 64 ||
        !spec.fields.every(fieldName) || new Set(spec.fields).size !== spec.fields.length) return null;
    policies.set(tool, { rowsField: spec.rowsField, fields: [...spec.fields] });
  }
  return policies;
}

/** structuredContent when present (never mixed with text, never a fallback when invalid), else the one JSON text block. No other block is read. */
function bodyOf(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const only = Array.isArray(result.content) && result.content.length === 1 ? result.content[0] : undefined;
  if (!record(only) || only.type !== 'text' || typeof only.text !== 'string' || only.text.length > MAX_BYTES) return undefined;
  try { return JSON.parse(only.text) as unknown; } catch { return undefined; }
}

/** Only own, explicitly named scalar fields enter a fresh object. */
export function projectRows(result: McpCallResult, policy: ResultProjection, scrub: (s: string) => string): ProjectedRow[] | undefined {
  const body = result?.isError ? undefined : bodyOf(result);
  if (!record(body) || !Object.hasOwn(body, policy.rowsField)) return undefined;
  const rows = body[policy.rowsField];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return undefined;
  const projected: ProjectedRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    if (!record(row)) return undefined;
    const next: ProjectedRow = {};
    for (const field of policy.fields) {
      if (!Object.hasOwn(row, field)) continue;
      const value = row[field];
      if (typeof value === 'string') {
        if (value.length > MAX_CELL) return undefined;
        const clean = scrub(value);
        if (clean.length > MAX_CELL) return undefined;
        next[field] = clean;
      } else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        // A resolved secret may be echoed as a JSON number or boolean.
        next[field] = scrub(String(value)) === String(value) ? value : null;
      } else return undefined;
    }
    if (!Object.keys(next).length) return undefined;
    bytes += Buffer.byteLength(JSON.stringify(next)) + (projected.length ? 1 : 0);
    if (bytes > MAX_BYTES) return undefined;
    projected.push(next);
  }
  return projected;
}
