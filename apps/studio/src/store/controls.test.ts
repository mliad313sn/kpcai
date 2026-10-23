import { describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/core';
import { controlText } from './controls';

const ref = { provider: 'p', model: 'm' };

describe('steering lines (R-304)', () => {
  it('describes every control event as one plain sentence', () => {
    setLocale('en');
    expect(controlText({ type: 'run_paused' })).toBe('Paused: nothing new starts');
    expect(controlText({ type: 'run_resumed' })).toBe('Resumed');
    expect(controlText({ type: 'run_cancelled' })).toMatch(/^Cancelled/);
    const redirect = (extra: Record<string, unknown>) =>
      controlText({ type: 'node_redirected', nodeId: 'n', ...extra } as never);
    expect(redirect({ to: ref })).toBe('#n redirected to p/m');
    expect(redirect({ to: ref, from: { provider: 'a', model: 'b' } })).toBe(
      '#n redirected from a/b to p/m',
    );
    expect(redirect({ to: ref, restarted: true })).toBe('#n redirected to p/m (restarted)');
    expect(redirect({ to: ref, from: ref, restarted: true })).toMatch(
      /from p\/m to p\/m \(restarted\)/,
    );
    expect(redirect({ to: 'bad' })).toBe('#n redirected to another model');
    expect(controlText({ type: 'instruction_added', text: 'x'.repeat(400) } as never)).toMatch(
      /^Instruction added to the run: x{300}…$/,
    );
    expect(controlText({ type: 'control_refused' })).toBe(
      'Refused action on the run: no reason given',
    );
  });

  it('speaks French', () => {
    setLocale('fr');
    expect(controlText({ type: 'run_resumed' })).toBe('Reprise');
    setLocale('en');
  });
});
