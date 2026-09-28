import { useRef } from 'react';
import { Halo, type HaloAnchor } from '../ui';
import capS from './Captions.module.css';
import { PROMISES } from './content';
import s from './PrivacySection.module.css';
import sec from './Section.module.css';

/** "It won't make things up about you": the three promises and a working ask-card demo. */
export function PrivacySection() {
  const askRef = useRef<HTMLDivElement>(null);
  const quietRef = useRef<HTMLParagraphElement>(null);

  const anchor = (box: DOMRect): HaloAnchor => {
    const ask = askRef.current?.getBoundingClientRect();
    const quiet = quietRef.current?.getBoundingClientRect();
    if (!ask || !quiet) return { rect: { x: 0, y: 0, w: 0, h: 0 } };
    return {
      rect: { x: ask.left - box.left, y: ask.top - box.top, w: ask.width, h: ask.height },
      lambda: 60,
      safeY: quiet.bottom - box.top - 10,
    };
  };

  return (
    <section className={sec.sec} id="privacy" aria-labelledby="priv-h" style={{ paddingTop: 0 }}>
      <div className={sec.wrap}>
        <header className={sec.head}>
          <h2 id="priv-h" className={`t-h2 ${sec.h2}`}>
            It won’t make things up about you
          </h2>
          <p>A relay only works if you can trust every word it says in your name.</p>
        </header>
        <div className={s.grid}>
          <ul className={s.promises}>
            {PROMISES.map((p) => (
              <li key={p.heading}>
                <h3>{p.heading}</h3>
                <p>{p.body}</p>
              </li>
            ))}
          </ul>
          <div className={`${s.askStage} night`}>
            <Halo pitch={12} gain={0.7} anchor={anchor} />
            <p className={capS.cap}>
              <span className={capS.by}>
                <i aria-hidden="true" />
                Dana · Riverside Pharmacy
              </span>
              Can I get your date of birth, please?
            </p>
            <p ref={quietRef} className={`${capS.cap} ${capS.you}`}>
              <span className={capS.by}>
                <i aria-hidden="true" />
                Said for you · automatic
              </span>
              One moment, please.
            </p>
            {/* biome-ignore lint/a11y/useSemanticElements: an illustrative ask card, not a form; role=group matches B */}
            <div ref={askRef} className={s.ask} role="group" aria-labelledby="askDemoH">
              <div className={s.askH}>
                <span className={s.ldot} aria-hidden="true" />
                <span id="askDemoH">Dana asks for your date of birth</span>
                <small>
                  <span className={s.w}>Waiting </span>0:04
                </small>
              </div>
              <p className={s.askNote}>
                The line is holding. Nothing about you is said until you choose.
              </p>
              <div className={s.askActs}>
                <button type="button" className={s.btnInk}>
                  Share “March 14, 1952” <small>from profile</small>
                </button>
                <button type="button" className={s.btnQuiet}>
                  Type an answer
                </button>
                <button type="button" className={s.btnQuiet}>
                  Decline
                </button>
              </div>
              <p className={s.askSrc}>From your profile. Not shared for this call yet.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
