import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MockSpec {
  id: string;
  jurisdiction?: string;
  price: [number, number];
  code: number;
  writing: number;
  analysis?: number;
  test?: number;
  critique?: number;
}

/** Writes offline mock providers into $KPAI_HOME/providers so routing has real choices. */
export function writeMockProviders(home: string, specs: readonly MockSpec[]): void {
  const dir = join(home, 'providers');
  mkdirSync(dir, { recursive: true });
  for (const s of specs) {
    writeFileSync(
      join(dir, `${s.id}.yaml`),
      [
        `id: ${s.id}`,
        `name: ${s.id}`,
        'kind: test',
        'adapter: mock',
        `jurisdiction: ${s.jurisdiction ?? 'US'}`,
        'retention: none',
        'models:',
        '  - id: m1',
        '    contextWindow: 32000',
        '    maxOutput: 4096',
        '    modalities: [text, code]',
        `    price: { inputPerMTok: ${s.price[0]}, outputPerMTok: ${s.price[1]} }`,
        `    competence: { code_generation: ${s.code}, test: ${s.test ?? s.code}, writing: ${s.writing}, critique: ${s.critique ?? s.writing}, analysis: ${s.analysis ?? 0.6}, research: 0.5, decision: 0.6 }`,
        '',
      ].join('\n'),
    );
  }
}

export const THREE_MOCKS: readonly MockSpec[] = [
  { id: 'mock-alpha', price: [2, 10], code: 0.9, writing: 0.6 },
  { id: 'mock-beta', jurisdiction: 'EU', price: [0.5, 2], code: 0.7, writing: 0.9 },
  { id: 'mock-gamma', jurisdiction: 'local', price: [0, 0], code: 0.5, writing: 0.5 },
];
