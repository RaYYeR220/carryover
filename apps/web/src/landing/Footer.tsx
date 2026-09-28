import { Link } from 'react-router';
import { DotWordmark } from '../ui';
import s from './Footer.module.css';

const PRODUCT_LINKS = [
  { to: '/app/new', label: 'Try a call' },
  { href: '#practice', label: 'Practice line' },
  { href: '#how', label: 'How it works' },
  { href: '#autonomy', label: 'Autonomy' },
];

const TRUST_LINKS = [
  { href: '#privacy', label: 'Privacy' },
  { href: '#privacy', label: 'What it shares' },
  { href: '#top', label: 'Accessibility' },
];

export function Footer() {
  return (
    <footer className={s.foot}>
      <div className={s.top}>
        <div>
          <a href="#top" aria-label="Carryover, back to top">
            <DotWordmark height={18} />
          </a>
          <p>
            A phone relay for Deaf, hard-of-hearing and speech-disabled people. Any phone, any
            business, your words.
          </p>
          <p className={s.builtOn}>Built on AssemblyAI.</p>
        </div>
        <div>
          <h3>Product</h3>
          <ul>
            {PRODUCT_LINKS.map((l) => (
              <li key={l.label}>
                {l.to ? <Link to={l.to}>{l.label}</Link> : <a href={l.href}>{l.label}</a>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Trust</h3>
          <ul>
            {TRUST_LINKS.map((l) => (
              <li key={l.label}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className={s.emerg}>
            <b>Not for emergencies.</b> Carryover is not a certified relay service. In the US, call
            or text 911; elsewhere, use your local emergency number.
          </p>
        </div>
      </div>
      <div className={s.bot}>
        <span>© 2026 Carryover</span>
        <span>Captions set in Atkinson Hyperlegible Next, designed for low-vision readers.</span>
      </div>
    </footer>
  );
}
