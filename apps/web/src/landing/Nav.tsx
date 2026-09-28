import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { buttonClass, DotWordmark } from '../ui';
import s from './Nav.module.css';

const LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#autonomy', label: 'Autonomy' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#practice', label: 'Practice line' },
];

/** Sticky nav: wordmark, section links, "Try a call", and a mobile menu. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={[s.nav, scrolled && s.scrolled].filter(Boolean).join(' ')}>
      <div className={s.navIn}>
        <a className={s.wm} href="#top" aria-label="Carryover, home">
          <DotWordmark height={19} />
        </a>
        <nav className={s.links} aria-label="Main">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <Link
          to="/app/new"
          className={`${buttonClass({ variant: 'ink', shape: 'pill', size: 'sm' })} ${s.cta}`}
        >
          Try a call
        </Link>
        <button
          type="button"
          className={s.menuBtn}
          aria-expanded={open}
          aria-controls="mnav"
          aria-label="Menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static decorative dot grid
              <i key={i} />
            ))}
          </span>
        </button>
      </div>
      <nav className={s.mnav} id="mnav" aria-label="Main" hidden={!open}>
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
