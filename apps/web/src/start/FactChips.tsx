import type { Fact } from '@carryover/protocol';
import { Link } from 'react-router';
import { factNote } from './request';
import s from './StartCallPage.module.css';

export interface FactChipsProps {
  /** The group's visible legend, e.g. "What Carryover may share". */
  label: string;
  facts: readonly Fact[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

/** The vault's facts as toggle chips: on = Carryover may offer this if asked. */
export function FactChips({ label, facts, selected, onToggle }: FactChipsProps) {
  return (
    <fieldset className={s.fieldset}>
      <legend className={s.lbl}>{label}</legend>
      {facts.length === 0 ? (
        <p className={s.help}>
          Your profile has no facts yet. Add some from the{' '}
          <Link to="/app/profile">profile page</Link> to share them on a call.
        </p>
      ) : (
        <div className={s.fchips}>
          {facts.map((f) => {
            const on = selected.has(f.key);
            const note = factNote(f.key);
            return (
              <button
                key={f.key}
                type="button"
                className={s.fchip}
                aria-pressed={on}
                onClick={() => onToggle(f.key)}
              >
                <span className={s.ck} aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M2 6.5l2.5 2.5L10 3.5"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span>
                  <b>{f.label}</b>
                  <small>
                    {f.value}
                    {note ? ` · ${note}` : ''}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
