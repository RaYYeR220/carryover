import { useEffect, useRef, useState } from 'react';
import { Pill, Segmented } from '../ui';
import s from './AutonomySection.module.css';
import { Captions } from './Captions';
import { AUTONOMY_LEVELS, type AutonomyLevel, CAPS_TABLE_ROWS } from './content';
import { deviceStyles } from './DeviceBar';
import sec from './Section.module.css';

const SendGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 19V5M5 12l7-7 7 7"
      fill="none"
      stroke="#000"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** "You decide how much it does": the autonomy fader and its worked example. */
export function AutonomySection() {
  const [value, setValue] = useState<AutonomyLevel['value']>('assist');
  const [shown, setShown] = useState<AutonomyLevel>(
    () =>
      AUTONOMY_LEVELS.find((l) => l.value === 'assist') ?? (AUTONOMY_LEVELS[0] as AutonomyLevel),
  );
  const [swap, setSwap] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    const next =
      AUTONOMY_LEVELS.find((l) => l.value === value) ?? (AUTONOMY_LEVELS[0] as AutonomyLevel);
    if (!mounted.current) {
      mounted.current = true;
      setShown(next);
      return;
    }
    setSwap(true);
    const t = window.setTimeout(() => {
      setShown(next);
      setSwap(false);
    }, 180);
    return () => window.clearTimeout(t);
  }, [value]);

  const colIndex = AUTONOMY_LEVELS.findIndex((l) => l.value === value);

  return (
    <section className={sec.sec} id="autonomy" aria-labelledby="auto-h" style={{ paddingTop: 0 }}>
      <div className={sec.wrap}>
        <header className={sec.head}>
          <h2 id="auto-h" className={`t-h2 ${sec.h2}`}>
            You decide how much it does
          </h2>
          <p>
            Pick a level before the call and change it any time during. At every level, it only says
            things about you that you chose to share.
          </p>
        </header>
        <div className={s.autoGrid}>
          <div>
            <Segmented
              tone="fader"
              label="How much Carryover does"
              value={value}
              onChange={setValue}
              options={AUTONOMY_LEVELS.map(({ value: v, label, level }) => ({
                value: v,
                label,
                level,
              }))}
            />
            <div className={s.lvl} aria-live="polite">
              <h3>{shown.heading}</h3>
              <p>{shown.body}</p>
            </div>
            <table className={s.table}>
              <caption className="sr">What Carryover does at each level</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr">Task</span>
                  </th>
                  {AUTONOMY_LEVELS.map((l, i) => (
                    <th
                      key={l.value}
                      scope="col"
                      className={`${s.c} ${i === colIndex ? s.sel : ''}`}
                    >
                      {l.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CAPS_TABLE_ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {row.on.map((on, i) => (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed 3-column row
                        key={i}
                        className={`${s.c} ${i === colIndex ? s.sel : ''}`}
                      >
                        <span
                          className={on ? s.y : undefined}
                          role="img"
                          aria-label={on ? 'Carryover' : 'You'}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={s.legend} aria-hidden="true">
              <span>
                <i className={s.y} />
                Carryover does it
              </span>
              <span>
                <i />
                You do it
              </span>
            </div>
          </div>
          <figure className={`${deviceStyles.device} ${s.ex} night`} aria-labelledby="exH">
            <div className={s.exH}>
              <Pill state={shown.pillState}>{shown.pillLabel}</Pill>
              <b id="exH">Lakeview Dental</b>
              <span>Example</span>
            </div>
            <div className={`${s.exFeed} ${swap ? s.swap : ''}`} aria-live="polite">
              <Captions items={shown.feed} />
            </div>
            <div className={s.exComp} aria-hidden="true">
              <div className={s.qrRow}>
                <span>Yes</span>
                <span>No</span>
                <span>Please repeat that</span>
                <span>One moment</span>
              </div>
              <div className={s.exIn}>
                <span>Type what you want said…</span>
                <i>
                  <SendGlyph />
                </i>
              </div>
            </div>
          </figure>
        </div>
      </div>
    </section>
  );
}
