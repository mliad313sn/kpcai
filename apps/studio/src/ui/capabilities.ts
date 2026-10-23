/**
 * Features that depend on protocol methods other seats are still adding (R-305 checkpoints,
 * R-307 runs manager and merge, WI-S6-01 artifacts). The UI shows them only when the
 * bundled protocol knows them, so a console never calls what its kernel cannot answer.
 */
import { Methods, Notifications } from '@kernelpai/kernel/protocol';

export function hasMethod(name: string): boolean {
  return Object.hasOwn(Methods, name);
}

export const RUN_MANAGER_METHODS = [
  'run.checkpoints',
  'run.restore',
  'runs.list',
  'run.merge',
  'run.discard',
] as const;

/** True once `run.done` carries an `artifacts` array (non-code deliverables). */
export function hasArtifacts(): boolean {
  const shape = (Notifications['run.done'] as unknown as { shape?: Record<string, unknown> }).shape;
  return !!shape && Object.hasOwn(shape, 'artifacts');
}
