import type { Autonomy } from '@carryover/protocol';
import { Link } from 'react-router';
import { Button, buttonClass, CAPTION_SIZES, DotWordmark, Pill, Segmented, Stepper } from '../ui';
import type { PillState } from '../ui/Pill';
import { HangUpIcon } from './icons';
import s from './TopBar.module.css';

export const AUTONOMY_OPTIONS = [
  { value: 'relay', label: 'Relay', level: 1 },
  { value: 'assist', label: 'Assist', level: 2 },
  { value: 'auto', label: 'Auto', level: 3 },
] as const satisfies readonly { value: Autonomy; label: string; level: number }[];

export interface TopBarProps {
  name: string;
  subtitle?: string;
  pill: { state: PillState; label: string };
  clock: string;
  autonomy: Autonomy;
  onAutonomy: (value: Autonomy) => void;
  captionSize: number;
  onCaptionSize: (px: number) => void;
  ended: boolean;
  /** Controls do nothing (sample call before it starts, or no connection yet). */
  onHangUp: () => void;
}

/** Callee, status pill, timer, autonomy, caption size and End call. */
export function TopBar({
  name,
  subtitle,
  pill,
  clock,
  autonomy,
  onAutonomy,
  captionSize,
  onCaptionSize,
  ended,
  onHangUp,
}: TopBarProps) {
  return (
    <header className={s.top}>
      <Link className={s.wm} to="/" aria-label="Carryover home">
        <DotWordmark ink="#fff" height={15} />
      </Link>
      <span className={s.vsep} aria-hidden="true" />
      <div className={s.callee}>
        <div className={s.calleeN}>
          <b>{name}</b>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <div className={s.calleeS}>
          <Pill state={pill.state} size="auto">
            {pill.label}
          </Pill>
          <span className={s.timer}>
            <span className="sr">Call time </span>
            {clock}
          </span>
        </div>
      </div>
      <div className={s.ctrls}>
        <Segmented
          className={s.mode}
          options={AUTONOMY_OPTIONS}
          value={autonomy}
          onChange={onAutonomy}
          label="How much Carryover does"
        />
        <Stepper
          values={CAPTION_SIZES}
          value={captionSize}
          onChange={onCaptionSize}
          label="Caption size"
          decreaseLabel="Smaller captions"
          increaseLabel="Larger captions"
          prefix="Aa"
          unit=" pixel captions"
        />
      </div>
      {ended ? (
        <Link className={buttonClass({ variant: 'white', className: s.endb })} to="/app/new">
          New call
        </Link>
      ) : (
        <Button variant="red" className={s.endb} icon={<HangUpIcon />} onClick={onHangUp}>
          End call
        </Button>
      )}
    </header>
  );
}
