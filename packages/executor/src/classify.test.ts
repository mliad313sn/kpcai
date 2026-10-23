import { describe, expect, it } from 'vitest';
import { classify } from './classify.js';

describe('classify', () => {
  it.each([
    // English
    ['Write unit tests for the parser with vitest', 'test'],
    ['Write tests for this function', 'test'],
    ['Review this pull request and point out the flaws', 'critique'],
    ['Implement a function that parses ISO dates in TypeScript', 'code_generation'],
    ['Refactor the payment module', 'code_generation'],
    ['```ts\nconst x = 1\n```\nwhat does this do', 'code_generation'],
    ['Should we use Postgres or SQLite? pros and cons', 'decision'],
    ['Find sources on the state of the art in retrieval', 'research'],
    ['Draft an email to the team announcing the release', 'writing'],
    ['Explain why the build is slow', 'analysis'],
    // French
    ['Écris des tests unitaires pour ce module', 'test'],
    ['Relis ce document et donne ton avis sur les points faibles', 'critique'],
    ['Implémente une fonction qui trie les factures', 'code_generation'],
    ['Corrige le bug dans le script de déploiement', 'code_generation'],
    ['Faut-il choisir Rust ou Go ? Avantages et inconvénients', 'decision'],
    ["Fais une recherche sur l'état de l'art des agents", 'research'],
    ['Rédige une lettre de motivation', 'writing'],
    ['Explique pourquoi la requête échoue', 'analysis'],
  ])('%s → %s', (prompt, type) => {
    const c = classify(prompt);
    expect(c.type).toBe(type);
    expect(c.confidence).toBeGreaterThanOrEqual(0.3);
    expect(c.confidence).toBeLessThanOrEqual(0.95);
    expect(c.reason).toContain(`${type}: matched`);
  });

  it('defaults to analysis with low confidence when nothing matches', () => {
    expect(classify('bonjour')).toEqual({
      type: 'analysis',
      confidence: 0.2,
      reason: 'no keyword matched; default analysis',
    });
  });

  it('breaks ties by specificity and names the runner-up', () => {
    const c = classify('review this code');
    expect(c.type).toBe('critique');
    expect(c.reason).toContain('runner-up code_generation: 1');
    expect(c.confidence).toBe(0.45);
  });

  it('gains confidence with more matching signals', () => {
    const weak = classify('add tests').confidence;
    const strong = classify('add unit tests with vitest and check coverage').confidence;
    expect(strong).toBeGreaterThan(weak);
  });
});
