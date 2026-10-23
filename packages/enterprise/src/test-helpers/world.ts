/** A kernel with offline mock providers in a git repo, and an Enterprise runtime over it. */
import { Kernel, type ConfirmRequest } from '@kernelpai/kernel';
import { recordingHost, type RecordingHost } from '../../../kernel/src/test-helpers/fixture.js';
import { DEFAULT_CONFIG, type EnterpriseConfig } from '../config.js';
import { EnterpriseRuntime } from '../runtime.js';

export interface World {
  host: RecordingHost;
  kernel: Kernel;
  rt: EnterpriseRuntime;
  emitted: Array<{ name: string; params: Record<string, unknown> }>;
  /** Questions that reached the human (not a program's envelope). */
  human: ConfirmRequest[];
  /** Ticks and waits until `done` holds (or fails after `max` ticks). */
  until(done: () => boolean, max?: number): Promise<void>;
  config(over: Partial<EnterpriseConfig>): void;
  close(): Promise<void>;
}

export const GOAL = [
  'Two parts:',
  '- add an OAuth state validator with tests [[diff:src/a.ts]] [[testdiff:test/a.test.ts]]',
  '- add a token parser with tests [[diff:src/b.ts]] [[testdiff:test/b.test.ts]]',
].join('\n');

export function world(env: Record<string, string> = {}, existing?: RecordingHost): World {
  const host = existing ?? recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100', ...env });
  const human: ConfirmRequest[] = [];
  const holder: { rt?: EnterpriseRuntime } = {};
  host.confirm = (req) => {
    const routed = holder.rt?.confirmFor(req);
    if (routed) return routed;
    human.push(req);
    return Promise.resolve(true);
  };
  const kernel = new Kernel(host);
  const emitted: World['emitted'] = [];
  const rt = new EnterpriseRuntime({
    kernel,
    env: host.env,
    options: { allowTest: true },
    emit: (name, params) => void emitted.push({ name, params }),
    pollMs: 5,
  });
  holder.rt = rt;
  const config = (over: Partial<EnterpriseConfig>): void =>
    rt.store.saveConfig({ ...DEFAULT_CONFIG, tickMs: 60_000, ...over });
  config({});
  return {
    host,
    kernel,
    rt,
    emitted,
    human,
    config,
    async until(done, max = 400) {
      for (let i = 0; i < max && !done(); i++) {
        await rt.daemon.tick();
        await rt.idle();
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!done()) throw new Error('condition not reached');
    },
    async close() {
      await rt.close();
      await kernel.close();
    },
  };
}
