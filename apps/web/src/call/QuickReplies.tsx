import s from './Composer.module.css';

export const QUICK_REPLIES = [
  'Yes',
  'No',
  'Please repeat that',
  'One moment',
  'Please speak slower',
] as const;

export interface QuickRepliesProps {
  /** Called with exactly the reply's label. */
  onSay: (text: string) => void;
  disabled?: boolean;
}

/** One-tap replies, said exactly as labelled. */
export function QuickReplies({ onSay, disabled }: QuickRepliesProps) {
  return (
    <fieldset className={s.quick} aria-label="Quick replies">
      {QUICK_REPLIES.map((label) => (
        <button key={label} type="button" disabled={disabled} onClick={() => onSay(label)}>
          {label}
        </button>
      ))}
    </fieldset>
  );
}
