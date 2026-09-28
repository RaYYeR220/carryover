import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Kbd } from '../ui';
import { HOW_STEPS, type HowStep } from './content';
import { HowDevice } from './HowDevice';
import s from './HowSection.module.css';
import sec from './Section.module.css';

function cx(...xs: (string | false | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

/** Step 3's body carries an inline "Speak now" key hint, like B. */
function stepBody(step: HowStep): ReactNode {
  if (step.key !== 'speak') return step.body;
  return (
    <>
      It introduces you, then says exactly what you type in a clear voice. If they’re still talking,
      it waits for a pause. You can always override that with{' '}
      <span style={{ whiteSpace: 'nowrap' }}>
        <Kbd tone="paper">Speak now</Kbd>.
      </span>
    </>
  );
}

/** "How a call works": steps scroll-driven on desktop, tabs on mobile, twinned with a live device. */
export function HowSection() {
  const [active, setActive] = useState<HowStep['key']>('menu');
  const sectionRef = useRef<HTMLElement>(null);
  const stepRefs = useRef(new Map<HowStep['key'], HTMLLIElement>());

  useEffect(() => {
    const onScroll = () => {
      if (window.innerWidth <= 860) return;
      const line = window.innerHeight * 0.45;
      let best: HowStep['key'] | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const step of HOW_STEPS) {
        const el = stepRefs.current.get(step.key);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + 20 - line);
        if (r.bottom > 0 && r.top < window.innerHeight && d < bestDist) {
          bestDist = d;
          best = step.key;
        }
      }
      const sec = sectionRef.current?.getBoundingClientRect();
      if (best && sec && sec.top < window.innerHeight * 0.5 && sec.bottom > 0) {
        setActive(best);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const step = HOW_STEPS.find((st) => st.key === active) ?? (HOW_STEPS[0] as HowStep);

  return (
    <section ref={sectionRef} className={sec.sec} id="how" aria-labelledby="how-h">
      <div className={sec.wrap}>
        <header className={sec.head}>
          <h2 id="how-h" className={`t-h2 ${sec.h2}`}>
            How a call works
          </h2>
          <p>
            One pharmacy refill, start to finish. Carryover stays on the line; you stay in charge of
            what gets said.
          </p>
        </header>
        <div className={s.grid}>
          <ol className={s.steps}>
            {HOW_STEPS.map((st) => (
              <li
                key={st.key}
                ref={(el) => {
                  if (el) stepRefs.current.set(st.key, el);
                  else stepRefs.current.delete(st.key);
                }}
                className={cx(s.step, st.key === active && s.on)}
              >
                <button
                  type="button"
                  className={s.stepB}
                  aria-controls="howDev"
                  aria-pressed={st.key === active}
                  onClick={() => setActive(st.key)}
                >
                  <span className={s.stepT}>{st.time}</span>
                  <span className={s.stepH}>{st.heading}</span>
                  <span className={s.stepS}>{st.shortLabel}</span>
                </button>
                <p className={s.stepP}>{stepBody(st)}</p>
              </li>
            ))}
          </ol>
          <div className={s.stick}>
            <div id="howDev">
              <HowDevice step={step} />
            </div>
            <p className={s.note}>Scroll, or pick a moment on the left.</p>
          </div>
          <div className={s.howText} aria-live="polite">
            <h3>{step.heading}</h3>
            <p>{stepBody(step)}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
