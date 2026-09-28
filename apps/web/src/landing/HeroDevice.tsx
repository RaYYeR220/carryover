import type { Ref } from 'react';
import { LedMatrix } from '../ui';
import { Captions } from './Captions';
import { DeviceBar, deviceStyles } from './DeviceBar';
import s from './HeroDevice.module.css';
import type { HeroFrame } from './heroFrame';

export interface HeroDeviceProps {
  frame: HeroFrame;
  deviceRef?: Ref<HTMLElement>;
}

/** The hero's device card: the live loop dial → menu → hold → pickup → captions demo. */
export function HeroDevice({ frame, deviceRef }: HeroDeviceProps) {
  return (
    <figure
      ref={deviceRef}
      className={[deviceStyles.device, s.heroDev, frame.phase === 'pickup' && s.flash]
        .filter(Boolean)
        .join(' ')}
      data-testid="hero-device"
      data-phase={frame.phase}
    >
      <figcaption className="sr">
        An example call to Riverside Pharmacy: Carryover presses 2 in the phone menu, waits on hold,
        flashes when Dana picks up, shows her words as captions and speaks an introduction for Maya.
      </figcaption>
      <div aria-hidden="true">
        <div className={s.bar}>
          <DeviceBar
            pillState={frame.pillState}
            pillLabel={frame.pillLabel}
            name="Riverside Pharmacy"
            sub={frame.who}
            time={frame.time}
          />
        </div>
        <div className={s.body}>
          <LedMatrix
            className={s.screen}
            scene={frame.scene}
            data={frame.data}
            level={frame.level}
            ring={frame.ring}
            pitch={7}
            narrowPitch={5}
            breakpoint={860}
          />
          <div className={s.caps}>
            <Captions items={frame.caps} />
          </div>
        </div>
      </div>
    </figure>
  );
}
