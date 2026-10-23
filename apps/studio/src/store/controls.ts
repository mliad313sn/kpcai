/** One line per steering event of a run (R-304), for the thread and the live region. */
import { t } from '../i18n/core';
import type { ControlEvent, Ref } from '../rpc/schemas';

const MAX_TEXT = 300;

function ref(v: unknown): string | undefined {
  const r = v as Partial<Ref> | null | undefined;
  return r && typeof r.provider === 'string' && typeof r.model === 'string'
    ? `${r.provider}/${r.model}`
    : undefined;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const clip = (t: string): string => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t);

const nodeName = (e: ControlEvent): string => (e.nodeId ? `#${e.nodeId}` : t('control.theRun'));

function redirected(e: ControlEvent & Record<string, unknown>): string {
  const to = ref(e.to) ?? t('control.anotherModel');
  const from = ref(e.from);
  const params = { node: nodeName(e), from: from ?? '', to };
  if (e.restarted === true)
    return t(from ? 'control.redirectedFromRestarted' : 'control.redirectedRestarted', params);
  return t(from ? 'control.redirectedFrom' : 'control.redirected', params);
}

/** Plain text (never HTML); fields a newer kernel adds are ignored. */
export function controlText(e: ControlEvent): string {
  const x = e as ControlEvent & Record<string, unknown>;
  switch (e.type) {
    case 'run_paused': {
      const inFlight = list(x.inFlight);
      return inFlight.length
        ? t('control.pausedInFlight', { nodes: inFlight.map((n) => `#${n}`).join(', ') })
        : t('control.paused');
    }
    case 'run_resumed':
      return t('control.resumed');
    case 'run_cancelled':
      return t('control.cancelled');
    case 'node_redirected':
      return redirected(x);
    case 'instruction_added':
      return t('control.instruction', {
        node: nodeName(e),
        text: clip(typeof x.text === 'string' ? x.text : ''),
      });
    case 'control_refused':
      return t('control.refused', {
        action: typeof x.action === 'string' ? x.action : t('control.action'),
        node: nodeName(e),
        reason: clip(e.reason ?? t('control.noReason')),
      });
  }
}
