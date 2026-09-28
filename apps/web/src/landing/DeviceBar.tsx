import { Pill, type PillState } from '../ui';
import s from './DeviceBar.module.css';

export interface DeviceBarProps {
  pillState: PillState;
  pillLabel: string;
  name: string;
  sub: string;
  time: string;
}

/** The device card's top row: status pill, callee name and line, and the clock. */
export function DeviceBar({ pillState, pillLabel, name, sub, time }: DeviceBarProps) {
  return (
    <div className={s.dbar}>
      <Pill state={pillState}>{pillLabel}</Pill>
      <span className={s.dwho}>
        <b>{name}</b>
        <span>{sub}</span>
      </span>
      <span className={s.dtime}>{time}</span>
    </div>
  );
}

export { s as deviceStyles };
