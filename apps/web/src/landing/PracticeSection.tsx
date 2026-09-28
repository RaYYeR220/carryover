import { useRef } from 'react';
import { Link } from 'react-router';
import { buttonClass, Halo, type HaloAnchor, LiveDot, QrDots } from '../ui';
import { PRACTICE_QR_LABEL, PRACTICE_QR_TEXT, PRACTICE_STEPS } from './content';
import s from './PracticeSection.module.css';

/** "Your phone becomes the pharmacy": the illustrative practice-line QR. */
export function PracticeSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const qrCardRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const anchor = (box: DOMRect): HaloAnchor => {
    const card = qrCardRef.current?.getBoundingClientRect();
    const status = statusRef.current?.getBoundingClientRect();
    if (!card || !status) return { rect: { x: 0, y: 0, w: 0, h: 0 } };
    return {
      rect: { x: card.left - box.left, y: card.top - box.top, w: card.width, h: card.height },
      cy: card.top - box.top + card.height / 2,
      lambda: 80,
      quiet: [
        {
          x: status.left - box.left - 8,
          y: status.top - box.top - 6,
          w: status.width + 16,
          h: status.height + 12,
        },
      ],
    };
  };

  return (
    <section ref={sectionRef} className={s.stage} id="practice" aria-labelledby="prac-h">
      <Halo pitch={13} gain={0.75} anchor={anchor} />
      <div className={s.practice}>
        <div>
          <h2 id="prac-h" className={`t-h2 ${s.h2}`}>
            Your phone becomes the pharmacy
          </h2>
          <p className={s.intro}>
            Try Carryover without calling a real business. Scan the code and your phone rings as
            Riverside Pharmacy. You play Dana, the pharmacist; Carryover calls you from this screen.
          </p>
          <ol className={s.steps}>
            {PRACTICE_STEPS.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, static 3-step list
              <li key={i} className={s.pstep}>
                <b aria-hidden="true">{i + 1}</b>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <div className={s.actions}>
            <Link
              to="/app/new?to=practice"
              className={buttonClass({ variant: 'light', shape: 'pill', size: 'lg' })}
            >
              <LiveDot />
              Start a practice call
            </Link>
            <Link to="/app/sample" className={s.tlink}>
              Watch a sample call
            </Link>
          </div>
        </div>
        <div className={s.qrWrap}>
          <p ref={statusRef} className={`t-dot ${s.qrStatus}`}>
            <LiveDot breathe />
            LINE OPEN
          </p>
          <div ref={qrCardRef} className={s.qrCard}>
            <QrDots text={PRACTICE_QR_TEXT} label={PRACTICE_QR_LABEL} />
          </div>
          <p className={s.qrCap}>
            Example code — your real code appears when you start a practice call.
          </p>
          <p className={s.qrNote}>
            No app needed. The practice line never calls a real business and closes after one call.
          </p>
        </div>
      </div>
    </section>
  );
}
