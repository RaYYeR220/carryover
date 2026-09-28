import { LedMatrix } from '../ui';
import { Captions } from './Captions';
import type { HowStep } from './content';
import { DeviceBar, deviceStyles } from './DeviceBar';
import s from './HowDevice.module.css';

export interface HowDeviceProps {
  step: HowStep;
}

/** The "how a call works" twin device: the current step, live. */
export function HowDevice({ step }: HowDeviceProps) {
  return (
    <figure className={`${deviceStyles.device} ${s.howDev}`}>
      <figcaption className="sr">{step.caption}</figcaption>
      <div aria-hidden="true">
        <div className={s.bar}>
          <DeviceBar
            pillState={step.pillState}
            pillLabel={step.pillLabel}
            name="Riverside Pharmacy"
            sub={step.who}
            time={step.deviceTime}
          />
        </div>
        <LedMatrix
          className={s.screen}
          scene={step.ledScene}
          data={step.ledData}
          level={step.ledLevel ?? 0}
          pitch={7}
          narrowPitch={5}
          breakpoint={860}
        />
        <div className={s.feed}>
          <Captions items={step.feed} />
        </div>
      </div>
    </figure>
  );
}
