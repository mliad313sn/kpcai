import { t } from '../i18n/core';
import { control } from '../store/actions';
import type { RunView } from '../store/types';

/** Principle 4: pause (in-flight work finishes, nothing new starts), resume, cancel. */
export function RunControls({ run }: { run: RunView }) {
  const live = ['starting', 'running', 'paused'].includes(run.state);
  return (
    <span className="row" role="group" aria-label={t('controls.label')}>
      {run.state === 'paused' ? (
        <button type="button" onClick={() => void control('resume', run.runId)}>
          <span aria-hidden="true">▶ </span>
          {t('controls.resume')}
        </button>
      ) : (
        <button type="button" disabled={!live} onClick={() => void control('pause', run.runId)}>
          <span aria-hidden="true">❚❚ </span>
          {t('controls.pause')}
        </button>
      )}
      <button
        type="button"
        className="danger"
        disabled={!live}
        onClick={() => void control('cancel', run.runId)}
      >
        <span aria-hidden="true">■ </span>
        {t('controls.cancel')}
      </button>
    </span>
  );
}
