import { useRef } from 'react';
import { Link } from 'react-router';
import { buttonClass, Halo, type HaloAnchor, LiveDot } from '../ui';
import s from './Hero.module.css';
import { HeroDevice } from './HeroDevice';
import { useHeroFrame } from './useHeroFrame';

/** The hero stage: claim, subline, primary CTAs and the live-loop device demo. */
export function Hero() {
  const { frame, rippleKey } = useHeroFrame();
  const deviceRef = useRef<HTMLElement>(null);
  const ledeRef = useRef<HTMLParagraphElement>(null);
  const howLinkRef = useRef<HTMLAnchorElement>(null);

  const anchor = (box: DOMRect): HaloAnchor => {
    const device = deviceRef.current?.getBoundingClientRect();
    const lede = ledeRef.current?.getBoundingClientRect();
    const link = howLinkRef.current?.getBoundingClientRect();
    if (!device || !lede || !link) return { rect: { x: 0, y: 0, w: 0, h: 0 } };
    const mobile = window.innerWidth < 860;
    const x = device.left - box.left;
    const y = device.top - box.top;
    return {
      rect: { x, y, w: device.width, h: device.height },
      lambda: mobile ? 70 : 110,
      safeY: lede.bottom - box.top + 12,
      quiet: [
        {
          x: link.left - box.left - 6,
          y: link.top - box.top - 4,
          w: link.width + 12,
          h: link.height + 8,
        },
      ],
      ell: {
        cx: x + device.width / 2,
        cy: y + 40,
        rx: device.width * (mobile ? 0.95 : 0.66),
        ry: mobile ? 300 : 330,
        p: 1.45,
        k: 0.95,
      },
    };
  };

  return (
    <section className={`${s.stage} ${s.hero}`} id="top" aria-labelledby="hero-h">
      <Halo anchor={anchor} gain={0.95} rippleKey={rippleKey} lift={frame.haloLift} />
      <div className={s.copy}>
        <h1 id="hero-h" className={s.h1}>
          Calls you can see.
        </h1>
        <p ref={ledeRef} className={s.lede}>
          Carryover joins an ordinary phone call and speaks for you. Read their words as they say
          them, type yours, and let it sit through menus and hold. The screen lights up when a
          person picks up.
        </p>
        <div className={s.actions}>
          <Link
            to="/app/new"
            className={buttonClass({ variant: 'light', shape: 'pill', size: 'lg' })}
          >
            <LiveDot />
            Try a call
          </Link>
          <a ref={howLinkRef} className={s.tlink} href="#how">
            How it works
          </a>
        </div>
      </div>
      <HeroDevice frame={frame} deviceRef={deviceRef} />
    </section>
  );
}
