import type { Autonomy, Fact, ScenarioInfo } from '@carryover/protocol';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { saveCallMeta } from '../call/meta';
import { ApiError, api } from '../lib/api';
import { saveCallToken, vault } from '../lib/store';
import { loadDescriptor } from '../profile/profileMeta';
import { ensureSeeded } from '../profile/seed';
import { Button, Segmented, Toast, useToast } from '../ui';
import { DestinationList } from './DestinationList';
import { FactChips } from './FactChips';
import { PracticeBox } from './PracticeBox';
import {
  buildStartCallRequest,
  DEFAULT_AUTONOMY,
  DEFAULT_SHARED_KEYS,
  DEFAULT_VOICE,
  type Destination,
  destinationLabel,
  targetFor,
  VOICE_LABELS,
  VOICES,
} from './request';
import s from './StartCallPage.module.css';
import { usePracticeLine } from './usePracticeLine';

const MODE_OPTIONS: readonly { value: Autonomy; label: string; level: number; help: string }[] = [
  {
    value: 'relay',
    label: 'Relay',
    level: 1,
    help: 'Only says what you type. You press menu keys from the keypad.',
  },
  {
    value: 'assist',
    label: 'Assist',
    level: 2,
    help: 'Handles menus and hold, and answers only from facts you share.',
  },
  {
    value: 'auto',
    label: 'Auto',
    level: 3,
    help: 'Works toward your goal and checks with you before agreeing to anything else.',
  },
];

const capitalize = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

export default function StartCallPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [toast, showToast, hideToast] = useToast();
  const destL = useId();
  const modeL = useId();

  const [ready, setReady] = useState(false);
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [destination, setDestination] = useState<Destination>({ kind: 'practice' });
  const [goal, setGoal] = useState('');
  const [autonomy, setAutonomy] = useState<Autonomy>(DEFAULT_AUTONOMY);
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);
  const [shared, setShared] = useState<ReadonlySet<string>>(DEFAULT_SHARED_KEYS);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const practice = usePracticeLine(destination.kind === 'practice');

  // Scenarios and the vault, once, on mount. `?to=practice` keeps the practice
  // line selected instead of defaulting to the first scenario.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads the query once, at load
  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    const wantsPractice = searchParams.get('to') === 'practice';
    api
      .scenarios({ signal: ac.signal })
      .then((list) => {
        if (!live) return;
        setScenarios(list);
        if (!wantsPractice && list.length > 0) {
          setDestination({ kind: 'scenario', scenario: list[0] as ScenarioInfo });
        }
        setReady(true);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setReady(true);
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Couldn’t load destinations.');
      });
    ensureSeeded()
      .then(() => vault.list())
      .then((f) => {
        if (live) setFacts(f);
      })
      .catch(() => {});
    return () => {
      live = false;
      ac.abort();
    };
  }, []);

  // A scenario's suggested goal and autonomy become the defaults for it; the
  // practice line has none, so it resets to the app defaults.
  useEffect(() => {
    if (destination.kind === 'scenario') {
      setGoal(destination.scenario.suggestedGoal ?? '');
      setAutonomy(destination.scenario.suggestedAutonomy);
    } else {
      setGoal('');
      setAutonomy(DEFAULT_AUTONOMY);
    }
  }, [destination]);

  const toggleFact = (key: string) => {
    setShared((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const target = targetFor(destination, practice.code);
  const canSubmit = target != null && !submitting;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || submitting) return;
    setSubmitting(true);
    setFormError(null);
    const userName = facts.find((f) => f.key === 'name')?.value ?? 'Maya Chen';
    const req = buildStartCallRequest({
      target,
      userName,
      userDescriptor: loadDescriptor(),
      autonomy,
      goal,
      facts,
      sharedKeys: shared,
      voice,
    });
    try {
      const res = await api.startCall(req);
      saveCallToken(res.callId, res.appToken);
      saveCallMeta(res.callId, {
        target,
        autonomy,
        ...(req.goal ? { goal: req.goal } : {}),
        voice: capitalize(voice),
        shared: [...shared],
      });
      navigate(`/app/call/${res.callId}`);
    } catch (err) {
      setSubmitting(false);
      const message = err instanceof ApiError ? err.message : 'Couldn’t start the call. Try again.';
      setFormError(message);
      showToast(message);
    }
  };

  const modeHelp = MODE_OPTIONS.find((m) => m.value === autonomy)?.help;

  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <div className={s.top}>
          <h1 className={s.h1}>New call</h1>
          <nav className={s.nav} aria-label="Carryover">
            <Link to="/app/new" aria-current="page">
              New call
            </Link>
            <Link to="/app/history">History</Link>
            <Link to="/app/profile">Profile</Link>
          </nav>
        </div>
        <p className={s.lede}>
          Carryover calls, you read along. Change any of this later from the call screen.
        </p>
        {loadError && (
          <p className={s.error} role="alert">
            {loadError}
          </p>
        )}

        {!ready ? (
          <p className={s.help}>Loading…</p>
        ) : (
          <form onSubmit={onSubmit}>
            <div className={s.startGrid}>
              <div>
                <span className={s.lbl} id={destL}>
                  Who should it call?
                </span>
                <DestinationList
                  scenarios={scenarios}
                  value={destination}
                  onChange={setDestination}
                  labelledBy={destL}
                />
                {destination.kind === 'practice' && (
                  <PracticeBox line={practice} onRegenerate={practice.regenerate} />
                )}
                {autonomy === 'auto' && (
                  <label className={s.field}>
                    <span className={s.lbl}>Goal (optional)</span>
                    <textarea
                      value={goal}
                      maxLength={400}
                      placeholder="What should Carryover try to get done?"
                      onChange={(e) => setGoal(e.target.value)}
                    />
                    <p className={s.help}>
                      Carryover works toward this and still checks with you before sharing anything
                      new.
                    </p>
                  </label>
                )}
              </div>
              <div>
                <FactChips
                  label="What Carryover may share"
                  facts={facts}
                  selected={shared}
                  onToggle={toggleFact}
                />
                <p className={s.help}>
                  Anything you leave off, it asks you first. It never guesses.
                </p>

                <span className={s.lbl} id={modeL}>
                  How much should it do?
                </span>
                <Segmented
                  tone="light"
                  labelledBy={modeL}
                  value={autonomy}
                  onChange={setAutonomy}
                  options={MODE_OPTIONS.map(({ value, label, level }) => ({ value, label, level }))}
                />
                <p className={s.modeHelp}>{modeHelp}</p>

                <label className={s.field}>
                  <span className={s.lbl}>Voice</span>
                  <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                    {VOICES.map((v) => (
                      <option key={v} value={v}>
                        {VOICE_LABELS[v]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className={s.footer}>
              <Button type="submit" variant="ink" size="lg" disabled={!canSubmit}>
                {submitting ? 'Calling…' : `Call ${destinationLabel(destination)}`}
              </Button>
              {formError && (
                <span className={s.error} role="alert">
                  {formError}
                </span>
              )}
            </div>
          </form>
        )}
      </div>
      <Toast message={toast} onDismiss={hideToast} position="fixed" />
    </div>
  );
}
