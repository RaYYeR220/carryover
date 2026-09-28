import { useId } from 'react';
import { LiveDot } from '../ui';
import { BuzzIcon, CloseIcon } from './icons';
import s from './PickupTakeover.module.css';

export interface PickupTakeoverProps {
  target: string;
  /** The paper frame is up right now (3 × 200 ms in the first 1.2 s). */
  flash: boolean;
  /** Reduced motion: a steady red frame instead of flashing. */
  frame: boolean;
  /** The "A person picked up" banner is showing. */
  banner: boolean;
  onDismiss: () => void;
}

/**
 * The one orchestrated moment: when a person picks up the whole screen flashes
 * paper-white (≤ 3 per second), then a banner stays for a few seconds. With
 * reduced motion there is no flashing, only a steady red frame and the banner.
 */
export function PickupTakeover({ target, flash, frame, banner, onDismiss }: PickupTakeoverProps) {
  const bannerId = useId();
  return (
    <>
      {flash && (
        <div className={s.flash} aria-hidden="true" data-testid="pickup-flash">
          <span className={s.tag}>
            <LiveDot size="lg" />
            LIVE
          </span>
          <h2>A person picked up.</h2>
          <p>You’re live with {target}. Captions are on.</p>
          <span className={s.buzz}>
            <BuzzIcon />
            Buzzing your phone
          </span>
        </div>
      )}
      {frame && <div className={s.frame} aria-hidden="true" data-testid="pickup-frame" />}
      {banner && (
        <div className={s.banner} role="status" aria-labelledby={bannerId}>
          <LiveDot />
          <b id={bannerId}>A person picked up</b>
          <span>You’re live with {target}</span>
          <button type="button" aria-label="Dismiss" onClick={onDismiss}>
            <CloseIcon />
          </button>
        </div>
      )}
    </>
  );
}
