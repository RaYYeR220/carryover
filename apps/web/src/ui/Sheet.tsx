import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import s from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Small Doto line above the title, e.g. "CALL ENDED". */
  kicker?: ReactNode;
  /** wide = start-call sheet (920), narrow = summary (640). */
  width?: 'wide' | 'narrow';
  footer?: ReactNode;
  children?: ReactNode;
  /** Element to focus on open; defaults to the sheet itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  /** Element made inert while the sheet is open. Default: #root. */
  inertSelector?: string;
  className?: string;
}

/**
 * A modal sheet: centred card on desktop, bottom sheet on mobile.
 * `aria-modal`, background inert, Esc and the scrim close it, focus returns
 * to where it was.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  kicker,
  width = 'wide',
  footer,
  children,
  initialFocus,
  closeLabel = 'Close',
  inertSelector = '#root',
  className,
}: SheetProps) {
  const titleId = useId();
  const descId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.querySelector<HTMLElement>(inertSelector);
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';

    (initialFocus?.current ?? sheetRef.current)?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (root) root.inert = wasInert;
      html.style.overflow = prevOverflow;
      previous?.focus({ preventScroll: true });
    };
  }, [open, inertSelector, initialFocus]);

  if (!open) return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut only; Esc and the close button cover keyboards
    <div
      className={s.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <section
        ref={sheetRef}
        className={[s.sheet, width === 'narrow' && s.narrow, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className={s.head}>
          <div>
            {kicker && (
              <span className={s.kicker}>
                <i aria-hidden="true" />
                {kicker}
              </span>
            )}
            <h2 id={titleId}>{title}</h2>
            {description && (
              <p id={descId} className={s.desc}>
                {description}
              </p>
            )}
          </div>
          <button type="button" className={s.close} aria-label={closeLabel} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2 2l8 8M10 2l-8 8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className={s.body}>{children}</div>
        {footer && <div className={s.foot}>{footer}</div>}
      </section>
    </div>,
    document.body,
  );
}
