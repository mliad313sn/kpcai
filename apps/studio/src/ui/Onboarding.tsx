import { useState } from 'react';
import { t, type Key } from '../i18n/core';
import { loadModels, requestPlan } from '../store/actions';
import { announce, patch, setPrefs, studio, useStudio } from '../store/store';
import type { PackHelp, Profile } from '../store/types';
import { Modal } from './Modal';

const PROFILES: Array<{ id: Profile; label: Key; hint: Key }> = [
  { id: 'economy', label: 'onboarding.economy', hint: 'onboarding.economyHint' },
  { id: 'balanced', label: 'onboarding.balanced', hint: 'onboarding.balancedHint' },
  { id: 'performance', label: 'onboarding.performance', hint: 'onboarding.performanceHint' },
];

function Providers() {
  const providers = useStudio((s) => s.providers);
  return (
    <section aria-labelledby="ob-providers">
      <h3 id="ob-providers">{t('onboarding.providers')}</h3>
      {providers.length === 0 ? (
        <p className="muted">{t('onboarding.noProviders')}</p>
      ) : (
        <ul className="providers">
          {providers.map((p) => (
            <li key={p.id}>
              <span aria-hidden="true">{p.available ? '✓ ' : '✕ '}</span>
              {t(p.available ? 'onboarding.ready' : 'onboarding.missing', {
                name: p.name,
                kind: t(p.kind === 'local' ? 'onboarding.local' : 'onboarding.cloud'),
                reason: p.reason,
              })}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => void loadModels()}>
        {t('onboarding.detect')}
      </button>
    </section>
  );
}

function ProfileChoice(props: { value: Profile; set: (p: Profile) => void }) {
  return (
    <fieldset>
      <legend>{t('onboarding.profile')}</legend>
      {PROFILES.map((p) => (
        <div key={p.id} className="radio">
          <input
            type="radio"
            id={`ob-${p.id}`}
            name="ob-profile"
            checked={props.value === p.id}
            onChange={() => props.set(p.id)}
            aria-describedby={`ob-${p.id}-hint`}
          />
          <label htmlFor={`ob-${p.id}`}>{t(p.label)}</label>
          <span id={`ob-${p.id}-hint`} className="muted small">
            {t(p.hint)}
          </span>
        </div>
      ))}
    </fieldset>
  );
}

function FreePath(props: { value: boolean; set: (v: boolean) => void }) {
  const local = useStudio((s) => s.providers.some((p) => p.kind === 'local' && p.available));
  return (
    <div className="radio">
      <input
        type="checkbox"
        id="ob-local"
        checked={props.value && local}
        disabled={!local}
        onChange={(e) => props.set(e.target.checked)}
        aria-describedby="ob-local-hint"
      />
      <label htmlFor="ob-local">{t('onboarding.free')}</label>
      <span id="ob-local-hint" className="muted small">
        {t(local ? 'onboarding.freeHint' : 'onboarding.freeMissing')}
      </span>
    </div>
  );
}

/** Glossary and tips of the selected domain packs (WI-S6-01), as text. */
export function PackTips({ packs }: { packs: PackHelp[] }) {
  if (packs.length === 0) return null;
  return (
    <section aria-labelledby="ob-tips">
      <h3 id="ob-tips">{t('onboarding.tips')}</h3>
      {packs.map((p) => (
        <div key={p.id}>
          <h4>{p.name}</h4>
          <ul>
            {p.tips.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
          {p.glossary.length > 0 && (
            <dl className="kv small">
              {p.glossary.map((g) => (
                <div key={g.term}>
                  <dt>{g.term}</dt>
                  <dd>{g.meaning}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </section>
  );
}

function finish(profile: Profile, localOnly: boolean): void {
  setPrefs((p) => ({ ...p, profile, localOnly, onboarded: true }));
  const runOptions = { ...studio.getState().runOptions, profile };
  if (localOnly) runOptions.localOnly = true;
  else delete runOptions.localOnly;
  patch({ onboardingOpen: false, runOptions });
}

/**
 * First run (R-308, spec §4.6): detected providers, a profile, the $0 local-only path and
 * a guided first task. Escape closes it for now; Skip or the first task close it for good.
 */
export function Onboarding() {
  const open = useStudio((s) => s.onboardingOpen);
  return open ? <OnboardingDialog /> : null;
}

function OnboardingDialog() {
  const prefs = useStudio((s) => s.prefs);
  const packs = useStudio((s) => s.packs);
  const [profile, setProfile] = useState<Profile>(prefs.profile);
  const [localOnly, setLocalOnly] = useState(prefs.localOnly);
  const [task, setTask] = useState(() => t('onboarding.sample'));
  const start = (e: React.FormEvent) => {
    e.preventDefault();
    finish(profile, localOnly);
    if (!task.trim()) return;
    announce(t('onboarding.guided'));
    void requestPlan(task.trim());
  };
  return (
    <Modal
      labelledBy="ob-title"
      describedBy="ob-intro"
      onClose={() => patch({ onboardingOpen: false })}
      className="onboarding"
    >
      <form onSubmit={start}>
        <h2 id="ob-title">{t('onboarding.title')}</h2>
        <p id="ob-intro">{t('onboarding.intro')}</p>
        <Providers />
        <ProfileChoice value={profile} set={setProfile} />
        <FreePath value={localOnly} set={setLocalOnly} />
        <PackTips packs={packs} />
        <label htmlFor="ob-task">{t('onboarding.task')}</label>
        <input id="ob-task" type="text" value={task} onChange={(e) => setTask(e.target.value)} />
        <div className="row end">
          <button type="button" onClick={() => finish(profile, localOnly)}>
            {t('onboarding.skip')}
          </button>
          <button type="submit" className="primary">
            {t('onboarding.start')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
