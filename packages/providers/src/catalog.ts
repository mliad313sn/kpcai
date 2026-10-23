import { z } from 'zod';
import type { ProviderDescriptor } from '@kernelpai/core';

/** The slice of models.dev `api.json` the catalog sync reads (MIT, models.dev). */
const ApiModelSchema = z
  .object({
    cost: z.object({ input: z.number().optional(), output: z.number().optional() }).loose(),
    limit: z.object({ context: z.number().optional(), output: z.number().optional() }).loose(),
  })
  .partial()
  .loose();
const ApiSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), ApiModelSchema).default({}) }).loose(),
);

export type CatalogField =
  'inputPerMTok' | 'outputPerMTok' | 'contextWindow' | 'maxOutput' | 'missing';

export interface CatalogChange {
  provider: string;
  model: string;
  field: CatalogField;
  yaml?: number;
  catalog?: number;
}

export interface CatalogDiff {
  changes: CatalogChange[];
  /** Providers not compared, with why. */
  skipped: Array<{ provider: string; reason: string }>;
  /** Number of model cards compared. */
  compared: number;
}

/**
 * Compares the prices and limits of every YAML model card with models.dev.
 * Pure: it never writes anything; the YAML stays the human-edited source of truth.
 * `providerMap` maps a descriptor id to a models.dev provider key when they differ.
 */
export function catalogDiff(
  descriptors: readonly ProviderDescriptor[],
  api: unknown,
  providerMap: Readonly<Record<string, string>> = {},
): CatalogDiff {
  const catalog = ApiSchema.parse(api);
  const diff: CatalogDiff = { changes: [], skipped: [], compared: 0 };
  for (const d of descriptors) {
    const key = providerMap[d.id] ?? d.id;
    const entry = catalog[key];
    if (d.kind === 'local' || d.kind === 'test') {
      diff.skipped.push({ provider: d.id, reason: `kind ${d.kind}` });
    } else if (!entry) {
      diff.skipped.push({ provider: d.id, reason: `no models.dev provider "${key}"` });
    } else {
      for (const card of d.models) {
        diff.compared++;
        diff.changes.push(...compareCard(d.id, card, entry.models[card.id]));
      }
    }
  }
  return diff;
}

function compareCard(
  provider: string,
  card: ProviderDescriptor['models'][number],
  remote: z.infer<typeof ApiModelSchema> | undefined,
): CatalogChange[] {
  if (!remote) return [{ provider, model: card.id, field: 'missing' }];
  const pairs: Array<[CatalogField, number, number | undefined]> = [
    ['inputPerMTok', card.price.inputPerMTok, remote.cost?.input],
    ['outputPerMTok', card.price.outputPerMTok, remote.cost?.output],
    ['contextWindow', card.contextWindow, remote.limit?.context],
    ['maxOutput', card.maxOutput, remote.limit?.output],
  ];
  return pairs
    .filter(([, yaml, catalog]) => catalog !== undefined && catalog !== yaml)
    .map(([field, yaml, catalog]) => ({ provider, model: card.id, field, yaml, catalog }));
}

/** Human-readable report, one line per change. */
export function formatCatalogDiff(diff: CatalogDiff): string {
  const lines = diff.changes.map((c) =>
    c.field === 'missing'
      ? `${c.provider}/${c.model}: not in models.dev (renamed or retired?)`
      : `${c.provider}/${c.model}: ${c.field} ${c.yaml} (yaml) -> ${c.catalog} (models.dev)`,
  );
  for (const s of diff.skipped) lines.push(`skipped ${s.provider}: ${s.reason}`);
  const n = diff.changes.length;
  lines.push(`${diff.compared} model card(s) compared, ${n} difference(s). YAML was not modified.`);
  return lines.join('\n');
}
