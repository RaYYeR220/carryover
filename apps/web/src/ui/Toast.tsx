import { useCallback, useEffect, useRef, useState } from 'react';
import s from './Toast.module.css';

/** A toast with an id, so showing the same text twice restarts the timer. */
export interface ToastMessage {
  text: string;
  id: number;
}

export interface ToastProps {
  /** Text to show; null hides the toast. */
  message: string | ToastMessage | null;
  onDismiss: () => void;
  /** Auto-hide after this many ms. Default 4200. */
  duration?: number;
  /** absolute = inside the nearest positioned container (call screen); fixed = viewport. */
  position?: 'absolute' | 'fixed';
  className?: string;
}

/** A short white notice at the top, announced politely. The live region stays mounted. */
export function Toast({
  message,
  onDismiss,
  duration = 4200,
  position = 'absolute',
  className,
}: ToastProps) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const text = typeof message === 'string' ? message : (message?.text ?? null);
  const id = typeof message === 'string' ? message : (message?.id ?? null);
  useEffect(() => {
    if (!text || id == null) return;
    const t = setTimeout(() => dismiss.current(), duration);
    return () => clearTimeout(t);
  }, [text, id, duration]);
  return (
    <div
      className={[s.region, position === 'fixed' && s.fixed, className].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
    >
      {text && (
        <div key={String(id)} className={s.toast}>
          {text}
        </div>
      )}
    </div>
  );
}

/** `const [toast, show, hide] = useToast()` then `<Toast message={toast} onDismiss={hide} />`. */
export function useToast(): [ToastMessage | null, (text: string) => void, () => void] {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const n = useRef(0);
  const show = useCallback((text: string) => {
    n.current += 1;
    setMessage({ text, id: n.current });
  }, []);
  const hide = useCallback(() => setMessage(null), []);
  return [message, show, hide];
}
