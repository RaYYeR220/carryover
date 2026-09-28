import type { AppCommand } from '@carryover/protocol';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { IconButton } from '../../ui';
import { CallScreen } from '../CallScreen';
import { initialView, reduce } from '../state';
import s from './CallFixture.module.css';
import {
  FIXTURE_DETAILS,
  FIXTURE_T0,
  FIXTURE_VAULT,
  FIXTURES,
  type FixtureState,
} from './fixtureEvents';

/**
 * Dev only (/app/call/_fixture?state=menu|hold|pickup|ask|captions|summary):
 * the call screen from canned events at a frozen clock, for comparing with
 * Glyph Night's screenshots. The side-panel player is a static stand-in for
 * the sample call's own controls.
 */
export default function CallFixture() {
  const [params] = useSearchParams();
  const name = (params.get('state') ?? 'menu') as FixtureState;
  const fx = FIXTURES[name] ?? FIXTURES.menu;
  const view = useMemo(() => fx.events.reduce(reduce, initialView), [fx]);
  const log = (cmd: AppCommand) => console.info('[fixture] command', cmd);

  return (
    <CallScreen
      key={name}
      view={view}
      onCommand={log}
      now={fx.now}
      startedAt={FIXTURE_T0}
      vault={FIXTURE_VAULT}
      details={FIXTURE_DETAILS}
      sideFooter={
        <section className={s.demo} aria-label="Sample call controls">
          <div className={s.head}>
            <b>Sample call</b>
            <span>fixture · {name}</span>
          </div>
          <div className={s.bar}>
            <i />
          </div>
          <p>Canned events at a frozen clock, for screenshots.</p>
        </section>
      }
      mobileControls={
        <>
          <IconButton label="Play sample call">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor" />
            </svg>
          </IconButton>
          <IconButton label="Replay sample call">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 3a5 5 0 1 1-4.6 3.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M2.6 2.4v4h4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </IconButton>
        </>
      }
    />
  );
}
