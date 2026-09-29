import { Fragment, type ReactNode } from 'react';
import s from './Captions.module.css';

export interface CaptionWord {
  text: string;
  /** `lc` = low confidence (dotted underline), `pt` = streaming partial (dim). */
  cls?: 'lc' | 'pt';
}

export type CaptionText = string | CaptionWord[];

export type CaptionItem =
  | { id: string; kind: 'them' | 'you' | 'menu'; who: string; text: CaptionText }
  | { id: string; kind: 'ev'; tag: string; text: string; sig?: boolean; time?: string }
  | { id: string; kind: 'goal'; text: string }
  | { id: string; kind: 'comp'; text: string; caret?: boolean }
  | { id: string; kind: 'ask'; text: string; share: string };

function cx(...xs: (string | false | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

function renderText(text: CaptionText): ReactNode {
  if (typeof text === 'string') return text;
  return text.map((w, i) => {
    // Punctuation stays attached to the word before it, with no space and
    // (for a low-confidence word) outside its dotted-underline span.
    const spaced = i > 0 && !/^[.,!?;:]/.test(w.text);
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: words of one static line are positional
      <Fragment key={i}>
        {spaced ? ' ' : ''}
        {w.cls ? <span className={s[w.cls]}>{w.text}</span> : w.text}
      </Fragment>
    );
  });
}

const SendGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 19V5M5 12l7-7 7 7"
      fill="none"
      stroke="#000"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** One caption-feed item: a spoken line, an event dot-row, a goal, a typed line, or a compact ask card. */
function CaptionItemView({ item }: { item: CaptionItem }) {
  switch (item.kind) {
    case 'them':
    case 'you':
    case 'menu':
      return (
        <p className={cx(s.cap, s[item.kind])}>
          <span className={s.by}>
            <i aria-hidden="true" />
            {item.who}
          </span>
          {renderText(item.text)}
        </p>
      );
    case 'ev':
      return (
        <p className={cx(s.ev, item.sig && s.sig)}>
          <span className={s.tag}>{item.tag}</span>
          <span>{item.text}</span>
          <span className={s.lead} aria-hidden="true" />
          {item.time && <time>{item.time}</time>}
        </p>
      );
    case 'goal':
      return (
        <p className={s.goal}>
          <b>GOAL</b>
          <span>{item.text}</span>
        </p>
      );
    case 'comp':
      return (
        <p className={s.miniComp}>
          <span>
            {item.text}
            {item.caret && <i className={s.caret} aria-hidden="true" />}
          </span>
          <span className={s.send} aria-hidden="true">
            <SendGlyph />
          </span>
        </p>
      );
    case 'ask':
      return (
        <div className={s.ask}>
          <div className={s.askH}>
            <span className={s.ldot} aria-hidden="true" />
            <span>{item.text}</span>
            <small>
              <span className={s.w}>Waiting </span>0:03
            </small>
          </div>
          <div className={s.askActs}>
            <span className={s.btnInk}>
              {item.share} <small>from profile</small>
            </span>
            <span className={s.btnQuiet}>Type an answer</span>
            <span className={s.btnQuiet}>Decline</span>
          </div>
        </div>
      );
    default:
      return null;
  }
}

export interface CaptionsProps {
  items: readonly CaptionItem[];
}

/**
 * A list of caption-feed items (spoken lines, event rows, a goal, a typed
 * line, a compact ask card). Purely presentational: the parent container
 * decides layout and whether children animate in (e.g. `> * { animation:
 * enter … }`), matching Glyph Night's `.hcaps`/`.hfeed`/`.ex-feed`.
 */
export function Captions({ items }: CaptionsProps) {
  return (
    <>
      {items.map((item) => (
        <CaptionItemView key={item.id} item={item} />
      ))}
    </>
  );
}
