/**
 * Memory editor actions (ADR-0027). The human adds, edits and removes facts, and keeps or
 * rejects the facts a model proposed. A model never calls these: its facts reach memory
 * only through a human's yes (here, or the `memory` confirmation of a run).
 */
import { t } from '../i18n/core';
import { call, fail, onMemoryAnswer } from './actions';
import { announce, patch, studio } from './store';
import type { MemoryLayer, MemoryView } from './types';

export const LAYERS: readonly MemoryLayer[] = ['user', 'project', 'session'];

function setMemory(update: (m: MemoryView) => MemoryView): void {
  patch({ memory: update(studio.getState().memory) });
}

/** The session layer needs a session: the one picked, the active run's, else the newest. */
export function memorySession(): string | undefined {
  const s = studio.getState();
  const fromRun = s.serverRuns.find((r) => r.runId === s.activeRunId)?.sessionId;
  return s.memory.sessionId ?? (fromRun || undefined) ?? s.sessions[0]?.id;
}

function ref(layer: MemoryLayer): { layer: MemoryLayer; sessionId?: string } {
  const sessionId = layer === 'session' ? memorySession() : undefined;
  return sessionId ? { layer, sessionId } : { layer };
}

async function loadLayer(layer: MemoryLayer): Promise<void> {
  if (layer === 'session' && !memorySession()) {
    setMemory((m) => {
      const layers = { ...m.layers };
      delete layers.session;
      return { ...m, layers };
    });
    return;
  }
  const r = await call('memory.list', ref(layer));
  const view = { file: r.file, exists: r.exists, facts: r.facts, problems: r.problems };
  setMemory((m) => ({ ...m, layers: { ...m.layers, [layer]: view } }));
}

/** Proposals waiting for a human; silent when the kernel cannot list them (background). */
export async function loadPending(quiet = false): Promise<void> {
  try {
    const { pending } = await call('memory.pending', {});
    setMemory((m) => ({ ...m, pending }));
  } catch (e) {
    if (!quiet) fail('fail.memory', e);
  }
}

/** Every layer and the proposals. */
export async function loadMemory(): Promise<void> {
  setMemory((m) => ({ ...m, loading: true }));
  try {
    await Promise.all([...LAYERS.map(loadLayer), loadPending()]);
  } catch (e) {
    fail('fail.memory', e);
  } finally {
    setMemory((m) => ({ ...m, loading: false }));
  }
}

export async function chooseSession(sessionId: string): Promise<void> {
  setMemory((m) => ({ ...m, sessionId }));
  try {
    await loadLayer('session');
  } catch (e) {
    fail('fail.memory', e);
  }
}

export async function addFact(layer: MemoryLayer, text: string, localOnly: boolean) {
  try {
    await call('memory.add', { ...ref(layer), text, ...(localOnly ? { localOnly } : {}) });
    announce(t('memory.announce.added', { layer: t(`memory.layer.${layer}`) }));
    await loadLayer(layer);
    return true;
  } catch (e) {
    fail('fail.memoryAdd', e);
    return false;
  }
}

export async function editFact(
  layer: MemoryLayer,
  id: string,
  edit: { text?: string; localOnly?: boolean },
): Promise<boolean> {
  try {
    await call('memory.edit', { ...ref(layer), id, ...edit });
    announce(t('memory.announce.edited'));
    await loadLayer(layer);
    return true;
  } catch (e) {
    fail('fail.memoryEdit', e);
    return false;
  }
}

export async function removeFact(layer: MemoryLayer, id: string): Promise<void> {
  try {
    await call('memory.remove', { ...ref(layer), id });
    announce(t('memory.announce.removed'));
    await loadLayer(layer);
  } catch (e) {
    fail('fail.memoryRemove', e);
  }
}

/** The human keeps a model's proposal: it becomes a fact, its model source kept. */
export async function confirmProposal(id: string): Promise<void> {
  try {
    const { fact } = await call('memory.confirm', { id });
    announce(t('memory.announce.kept', { layer: t(`memory.layer.${fact.layer}`) }));
    await Promise.all([loadPending(), loadLayer(fact.layer)]);
  } catch (e) {
    fail('fail.memoryConfirm', e);
  }
}

export async function rejectProposal(id: string): Promise<void> {
  try {
    await call('memory.reject', { id });
    announce(t('memory.announce.rejected'));
    await loadPending();
  } catch (e) {
    fail('fail.memoryReject', e);
  }
}

const SETTLE_MS = 400;

/**
 * After a memory question is answered the queue changes and a yes adds a fact. The kernel
 * stores it just after it takes the answer, so the editor reads again now and once more
 * shortly after.
 */
function refreshAfterAnswer(layer: MemoryLayer): void {
  const refresh = () => {
    void loadPending(true);
    if (studio.getState().memory.layers[layer]) loadLayer(layer).catch(() => undefined);
  };
  refresh();
  setTimeout(refresh, SETTLE_MS);
}

onMemoryAnswer(refreshAfterAnswer);
