import type { ScenarioInfo } from '@carryover/protocol';
import { type Destination, destinationId, destinationLabel } from './request';
import s from './StartCallPage.module.css';

export interface DestinationListProps {
  scenarios: readonly ScenarioInfo[];
  value: Destination;
  onChange: (d: Destination) => void;
  labelledBy: string;
}

/** Radiogroup of destinations: the practice line, then each simulated scenario. */
export function DestinationList({ scenarios, value, onChange, labelledBy }: DestinationListProps) {
  const options: Destination[] = [
    { kind: 'practice' },
    ...scenarios.map((scenario): Destination => ({ kind: 'scenario', scenario })),
  ];
  const currentId = destinationId(value);

  return (
    <div className={s.dest} role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((d) => {
        const id = destinationId(d);
        const checked = id === currentId;
        return (
          <label key={id} className={checked ? s.destOn : undefined}>
            <input
              type="radio"
              name="dest"
              checked={checked}
              onChange={() => onChange(d)}
              value={id}
            />
            <span className={s.rd} aria-hidden="true" />
            <span>
              <b>{destinationLabel(d)}</b>
              <small>
                {d.kind === 'practice'
                  ? 'Your phone becomes the other side'
                  : (d.scenario.business ?? d.scenario.description)}
              </small>
            </span>
            <span className={[s.tag, d.kind === 'practice' && s.tagRed].filter(Boolean).join(' ')}>
              {d.kind === 'practice' ? 'Try it' : 'Simulated line'}
            </span>
          </label>
        );
      })}
    </div>
  );
}
