import {
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Kbd } from '../ui';
import s from './Composer.module.css';
import { SendIcon } from './icons';

/** The protocol's cap for one `say`; longer text is split by the server under this. */
export const MAX_SAY_CHARS = 2000;

export interface ComposerProps {
  /** Called with the trimmed text; never with an empty string. */
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Show the keyboard hint row under the box (desktop). */
  hint?: boolean;
}

/**
 * What the user types to be said for them. Enter speaks it, Shift+Enter adds a
 * line; whitespace-only text never sends. Long pastes go through whole.
 */
export function Composer({
  onSend,
  placeholder = 'Type what you want said…',
  disabled,
  inputRef,
  hint,
}: ComposerProps) {
  const id = useId();
  const [value, setValue] = useState('');
  const [hit, setHit] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);

  // The send button dips briefly after each send.
  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(0), 300);
    return () => clearTimeout(t);
  }, [hit]);

  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled) return;
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
    setHit((n) => n + 1);
    requestAnimationFrame(() => grow(box.current));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  const setRefs = (el: HTMLTextAreaElement | null) => {
    box.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef) inputRef.current = el;
  };

  return (
    <>
      <form className={s.composer} autoComplete="off" onSubmit={submit}>
        <label className="sr" htmlFor={id}>
          What Carryover should say for you
        </label>
        <textarea
          ref={setRefs}
          id={id}
          rows={1}
          value={value}
          placeholder={placeholder}
          enterKeyHint="send"
          maxLength={MAX_SAY_CHARS}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            grow(e.target);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          className={[s.send, hit > 0 && s.hit].filter(Boolean).join(' ')}
          type="submit"
          aria-label="Speak this"
          disabled={disabled}
        >
          <SendIcon />
        </button>
      </form>
      {hint && (
        <p className={s.hint}>
          <span>
            <Kbd>Enter</Kbd> speaks it
          </span>
          <span>
            <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> new line
          </span>
          <span>Carryover says your words exactly as typed.</span>
        </p>
      )}
    </>
  );
}
