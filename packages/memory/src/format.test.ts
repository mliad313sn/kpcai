import { describe, expect, it } from 'vitest';
import { decodeValue, encodeValue, formatAttrs, parseAttrs } from './attrs.js';
import { appendFact, emptyDoc, factsOf, parseMemory, serializeMemory } from './format.js';

const FILE = `---
kpai: memory
version: 1
layer: project
---

# Project memory

Some prose the human wrote.

- Use pnpm, never npm. <!-- kpai id=m-aaaa1111 source=human date=2026-10-20 -->
- Tests sit next to sources. <!-- kpai id=m-bbbb2222 source=mock-alpha/m1 date=2026-10-21 evidence=run:r1,node:code confirmed=2026-10-22 local-only -->

## Decisions

* Hand-written fact without provenance
- Long fact that the human wrapped <!-- kpai id=m-cccc3333 source=human date=2026-10-22 -->
  onto a second line
\`\`\`
- not a fact: inside a code fence
\`\`\`
`;

describe('memory Markdown parser', () => {
  it('reads facts with provenance, prose and front matter', () => {
    const doc = parseMemory(FILE, 'project');
    const facts = factsOf(doc);
    expect(facts.map((f) => f.text)).toEqual([
      'Use pnpm, never npm.',
      'Tests sit next to sources.',
      'Hand-written fact without provenance',
      'Long fact that the human wrapped onto a second line',
    ]);
    expect(facts[1]!.provenance).toEqual({
      source: 'mock-alpha/m1',
      date: '2026-10-21',
      evidence: ['run:r1', 'node:code'],
      localOnly: true,
      confirmed: '2026-10-22',
    });
    expect(facts[2]!.provenance.source).toBe('human');
    expect(facts[2]!.id).toMatch(/^m-[0-9a-f]{8}$/);
    expect(facts[3]!.id).toBe('m-cccc3333');
    expect(doc.problems.map((p) => p.message)).toEqual([
      'no provenance: read as a fact you wrote',
      'continuation line joined to the fact above',
    ]);
  });

  it('round-trips: serialize then parse gives the same facts and keeps the prose', () => {
    const doc = parseMemory(FILE, 'project');
    const text = serializeMemory(doc);
    const again = parseMemory(text, 'project');
    expect(factsOf(again)).toEqual(factsOf(doc));
    expect(again.problems).toEqual([]);
    expect(text).toContain('Some prose the human wrote.');
    expect(text).toContain('## Decisions');
    expect(text).toContain('- not a fact: inside a code fence');
    expect(serializeMemory(again)).toBe(text);
  });

  it('keeps the derived id of a hand-written fact stable between reads', () => {
    const a = factsOf(parseMemory('- a fact\n', 'user'))[0]!.id;
    const b = factsOf(parseMemory('# t\n\n- a fact\n', 'user'))[0]!.id;
    expect(a).toBe(b);
  });

  it('reports odd provenance without losing it', () => {
    const doc = parseMemory(
      [
        '- one <!-- kpai id=bad source=human date=yesterday flavour=mint shiny -->',
        '- two <!-- kpai id=m-dddd4444 date=2026-01-01 -->',
        '- three <!-- kpai id=m-dddd4444 source=human -->',
        '- ',
        '- four <!-- a plain comment -->',
      ].join('\n'),
      'user',
    );
    const facts = factsOf(doc);
    expect(facts).toHaveLength(4);
    expect(facts[0]!.extra).toEqual({ flavour: 'mint', shiny: '' });
    expect(facts[0]!.provenance.date).toBe('yesterday');
    expect(facts[1]!.provenance.source).toBe('unknown');
    expect(facts[2]!.id).not.toBe('m-dddd4444');
    expect(facts[3]!.text).toBe('four <!-- a plain comment -->');
    const messages = doc.problems.map((p) => `${p.line}: ${p.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        '1: unknown provenance attribute "flavour" kept as is',
        '1: unknown provenance flag "shiny" kept as is',
        '1: date "yesterday" is not YYYY-MM-DD',
        '1: id "bad" is not valid; replaced',
        '2: provenance has no source: treated as untrusted',
        '3: id m-dddd4444 repeated; replaced',
        '4: empty list item; kept as text',
      ]),
    );
    const text = serializeMemory(doc);
    expect(text).toContain('flavour=mint shiny');
    expect(text).toContain('date=yesterday');
    expect(text).toMatch(/^- *$/m);
  });

  it('tolerates a broken front matter, a layer mismatch and CRLF', () => {
    const open = parseMemory('---\nkpai: memory\n- fact\n', 'user');
    expect(open.problems[0]!.message).toMatch(/not closed/);
    expect(factsOf(open)).toHaveLength(1);
    const other = parseMemory('---\nlayer: user\nnot yaml\n---\r\n- x\r\n', 'project');
    expect(other.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([
        'front matter says layer user; read as project',
        'front matter line is not "key: value"; kept',
      ]),
    );
    expect(factsOf(other)[0]!.text).toBe('x');
  });

  it('appends after the last fact, or after the header of an empty file', () => {
    const doc = emptyDoc('project', { repo: '/r\nx' });
    const fact = (id: string) => ({
      id,
      layer: 'project' as const,
      text: id,
      provenance: { source: 'human', date: '2026-10-23', evidence: [], localOnly: false },
    });
    appendFact(doc, fact('m-0001'));
    appendFact(doc, fact('m-0002'));
    const text = serializeMemory(doc);
    expect(text).toMatch(/repo: \/r x/);
    expect(text).toContain('Keep the trailing kpai comment');
    expect(text.trimEnd().split('\n').slice(-3)).toEqual([
      '',
      '- m-0001 <!-- kpai id=m-0001 source=human date=2026-10-23 -->',
      '- m-0002 <!-- kpai id=m-0002 source=human date=2026-10-23 -->',
    ]);
  });
});

describe('provenance attributes', () => {
  it('encodes values so a comment can never be closed or split', () => {
    const v = 'a b,c-->%é';
    expect(encodeValue(v)).not.toMatch(/[\s,>]/);
    expect(decodeValue(encodeValue(v))).toBe(v);
    expect(decodeValue('%E0%A4%A')).toBe('%E0%A4%A');
    const c = formatAttrs('m-1234', {
      source: 'p/m 1',
      date: '2026-10-23',
      evidence: ['run:a,b'],
      localOnly: false,
      edited: '2026-10-24',
    });
    expect(c).toBe(
      '<!-- kpai id=m-1234 source=p/m%201 date=2026-10-23 evidence=run:a%2Cb edited=2026-10-24 -->',
    );
    const back = parseAttrs(c.slice('<!-- kpai'.length, -3));
    expect(back.provenance.evidence).toEqual(['run:a,b']);
    expect(back.provenance.source).toBe('p/m 1');
    expect(back.provenance.edited).toBe('2026-10-24');
  });
});
