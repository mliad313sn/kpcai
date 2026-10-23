/** Test hosts that hold a confirmation open, and requests with several diffs per node. */
import { recordingHost } from './fixture.js';

/** A fenced diff creating `file`; the mock author echoes the request, so its reply holds it. */
export function creation(file: string, line: string): string {
  return [
    '```diff',
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${line}`,
    '```',
  ].join('\n');
}

/** A code request whose implementation node answers with two diffs. */
export const TWO_PATCHES = [
  'add an OAuth state validator with tests',
  creation('a.txt', 'A shown'),
  creation('b.txt', 'B never shown'),
  '',
].join('\n');

/** A host whose `nth` step question is held open; everything else is a yes. */
export function holdingHost(nth = 1) {
  const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
  const hold: { release?: (ok: boolean) => void; held?: string; cancelled: string[] } = {
    cancelled: [],
  };
  host.cancelConfirmations = (runId) => void hold.cancelled.push(runId);
  let steps = 0;
  host.confirm = (req) => {
    host.asked.push(req);
    if (hold.release || req.kind !== 'budget' || req.question.includes('graph estimate'))
      return Promise.resolve(true);
    if (++steps < nth) return Promise.resolve(true);
    hold.held = req.runId;
    return new Promise((r) => (hold.release = r));
  };
  return { host, hold };
}

export const until = async (f: () => boolean): Promise<void> => {
  while (!f()) await new Promise((r) => setTimeout(r, 5));
};
