import type { Autonomy } from '@carryover/protocol';
import { useCallback, useRef, useState } from 'react';
import type { RingState } from '../led/glyphRing';
import type { LedScene, LedSceneData } from '../led/led';
import {
  Button,
  CAPTION_SIZES,
  DotWordmark,
  Halo,
  type HaloAnchor,
  IconButton,
  Kbd,
  LedMatrix,
  LiveDot,
  Pill,
  QrDots,
  Segmented,
  Sheet,
  Stepper,
  Toast,
  useSurface,
  useToast,
} from '../ui';
import s from './UiShowcase.module.css';

/** Dev-only page (/_ui) that renders every primitive for screenshot comparison with the design. */

const MODES = [
  { value: 'relay', label: 'Relay', level: 1 },
  { value: 'assist', label: 'Assist', level: 2 },
  { value: 'auto', label: 'Auto', level: 3 },
] as const satisfies readonly { value: Autonomy; label: string; level: number }[];

interface Demo {
  title: string;
  sub: string;
  scene: LedScene;
  data?: LedSceneData;
  level?: number;
  ring: RingState | RingState[];
}

const DEMOS: Demo[] = [
  { title: 'Calling Riverside Pharmacy', sub: 'dial', scene: 'dial', ring: 'off' },
  { title: 'Phone menu', sub: 'menu, listening', scene: 'menu', ring: 'off' },
  {
    title: 'Pressed 2 for prescriptions',
    sub: 'menu, key 2',
    scene: 'menu',
    data: { key: '2' },
    ring: ['on', 'off', 'off', 'on', 'off', 'off'],
  },
  {
    title: 'On hold · 2:34',
    sub: 'hold, counting',
    scene: 'hold',
    data: { seconds: 154 },
    ring: ['on', 'on', 'on', 'dim', 'dim', 'dim'],
  },
  { title: 'A person picked up', sub: 'flash (3× in 1.2 s)', scene: 'flash', ring: 'red' },
  {
    title: 'Dana is speaking',
    sub: 'live, level 1',
    scene: 'live',
    data: { name: 'Dana' },
    level: 1,
    ring: 'dim',
  },
  {
    title: 'Speaking for you',
    sub: 'live YOU, level 0.6',
    scene: 'live',
    data: { name: 'you' },
    level: 0.6,
    ring: 'dim',
  },
  { title: 'Live with Dana', sub: 'live, quiet', scene: 'live', ring: 'dim' },
  { title: 'Waiting for you', sub: 'ask', scene: 'ask', ring: 'red' },
  { title: 'Call ended · 5:25', sub: 'end', scene: 'end', ring: 'off' },
  { title: 'Ready', sub: 'idle', scene: 'idle', ring: 'off' },
];

const STRIPS: Demo[] = [
  { title: 'On hold · 2:34', sub: '', scene: 'hold', data: { seconds: 154 }, ring: 'off' },
  {
    title: 'Dana is speaking',
    sub: '',
    scene: 'live',
    data: { name: 'Dana' },
    level: 1,
    ring: 'off',
  },
  { title: 'Pressed 2', sub: '', scene: 'menu', data: { key: '2' }, ring: 'off' },
  { title: 'Waiting for you', sub: '', scene: 'ask', ring: 'off' },
];

const HangUp = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path
      d="M3.4 14.6c4.8-4.1 12.4-4.1 17.2 0l-1.9 2.6c-.3.4-.9.5-1.3.3l-2.6-1.3a1 1 0 0 1-.5-1.1l.3-1.5a10 10 0 0 0-5.2 0l.3 1.5a1 1 0 0 1-.5 1.1l-2.6 1.3c-.4.2-1 .1-1.3-.3z"
      fill="currentColor"
    />
  </svg>
);

const Replay = () => (
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
);

export default function UiShowcase() {
  useSurface('paper');
  const params = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<Autonomy>('assist');
  const [startMode, setStartMode] = useState<Autonomy>('assist');
  const [fader, setFader] = useState<Autonomy>('assist');
  const [cap, setCap] = useState(28);
  const [sheet, setSheet] = useState(params.has('sheet'));
  const [toast, showToast, hideToast] = useToast();
  const [pickups, setPickups] = useState(0);
  const devRef = useRef<HTMLElement>(null);

  const heroAnchor = useCallback((box: DOMRect): HaloAnchor => {
    const d = devRef.current?.getBoundingClientRect();
    if (!d) return { rect: { x: 0, y: box.height, w: box.width, h: 0 } };
    const x = d.left - box.left;
    const y = d.top - box.top;
    return {
      rect: { x, y, w: d.width, h: d.height },
      lambda: 110,
      safeY: y - 120,
      ell: { cx: x + d.width / 2, cy: y + 40, rx: d.width * 0.66, ry: 330, p: 1.45, k: 0.95 },
    };
  }, []);

  return (
    <main className={s.page}>
      <header className={s.head}>
        <DotWordmark height={19} />
        <h1>UI primitives</h1>
        <Button variant="ink" shape="pill" size="sm" onClick={() => setSheet(true)}>
          Open sheet
        </Button>
      </header>

      {/* Call-screen chrome */}
      <section className={`${s.stage} night`} aria-label="Call screen controls">
        <div className={s.topbar}>
          <DotWordmark ink="#fff" height={15} />
          <span className={s.vsep} aria-hidden="true" />
          <div className={s.callee}>
            <b>Riverside Pharmacy</b>
            <span>(555) 014-2230 · simulated line</span>
          </div>
          <Pill state="live" size="auto">
            LIVE
          </Pill>
          <span className={s.timer}>5:17</span>
          <div className={s.ctrls}>
            <Segmented
              options={MODES}
              value={mode}
              onChange={setMode}
              label="How much Carryover does"
            />
            <Stepper
              values={CAPTION_SIZES}
              value={cap}
              onChange={setCap}
              label="Caption size"
              decreaseLabel="Smaller captions"
              increaseLabel="Larger captions"
              prefix="Aa"
              unit=" pixel captions"
            />
          </div>
          <Button variant="red" icon={<HangUp />}>
            End call
          </Button>
        </div>

        <div>
          <p className={s.label}>Status pills</p>
          <div className={s.row}>
            <Pill state="dial">DIALING</Pill>
            <Pill state="menu">MENU</Pill>
            <Pill state="hold">HOLD</Pill>
            <Pill state="live">LIVE</Pill>
            <Pill state="ask">LIVE</Pill>
            <Pill state="ended">ENDED</Pill>
            <Pill state="hold" size="sm">
              HOLD
            </Pill>
          </div>
        </div>

        <div>
          <p className={s.label}>Buttons on night</p>
          <div className={s.row}>
            <Button variant="white">Speak now</Button>
            <Button variant="ghost" icon={<Replay />}>
              Replay
            </Button>
            <Button variant="red" icon={<HangUp />}>
              End call
            </Button>
            <Button variant="light" shape="pill" size="lg" dot>
              Try a call
            </Button>
            <Button variant="line" shape="pill" size="lg">
              How it works
            </Button>
            <Button variant="white" size="sm">
              Add to calendar
            </Button>
            <Button variant="ghost" size="sm">
              Copy details
            </Button>
            <Button variant="ghost" disabled>
              Disabled
            </Button>
            <IconButton label="Replay sample call">
              <Replay />
            </IconButton>
          </div>
        </div>

        <div>
          <p className={s.label}>LED screens (desktop, pitch 6.5, glyph ring)</p>
          <div className={s.row} style={{ marginBottom: 12 }}>
            <Button variant="ghost" size="sm" onClick={() => setPickups((n) => n + 1)}>
              Replay pickup
            </Button>
          </div>
          <div className={s.grid}>
            {DEMOS.map((d) => (
              <div className={s.device} key={d.sub}>
                <LedMatrix
                  key={d.scene === 'flash' ? `flash-${pickups}` : d.sub}
                  className={s.screenLg}
                  scene={d.scene}
                  data={d.data}
                  level={d.level}
                  ring={d.ring}
                />
                <div className={s.caption}>
                  <b>{d.title}</b>
                  <span>{d.sub}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className={s.label}>LED strips (mobile bar, pitch 5)</p>
          <div className={s.strips}>
            {STRIPS.map((d) => (
              <div className={s.strip} key={d.title}>
                <LedMatrix
                  className={s.screenStrip}
                  scene={d.scene}
                  data={d.data}
                  level={d.level}
                  pitch={5}
                  responsive
                />
                <div className={s.stripCap}>{d.title}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className={s.label}>Toast · kbd · live dot</p>
          <div className={s.toastHost}>
            <Toast message={toast} onDismiss={hideToast} />
          </div>
          <div className={s.row} style={{ marginTop: 12 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => showToast('Assist from now on. Carryover handles menus and hold.')}
            >
              Show toast
            </Button>
            <span>
              <Kbd>Enter</Kbd> speaks it · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> new line
            </span>
            <LiveDot />
            <LiveDot breathe />
          </div>
        </div>
      </section>

      {/* Landing hero stage with the dot halo */}
      <section className={`${s.hero} night`} aria-label="Halo stage">
        <Halo anchor={heroAnchor} gain={0.95} rippleKey={pickups} />
        <div className={s.heroCopy}>
          <h2 className="t-hero">Calls you can see.</h2>
          <p>
            Carryover joins an ordinary phone call and speaks for you. The screen lights up when a
            person picks up.
          </p>
          <div className={s.row}>
            <Button
              variant="light"
              shape="pill"
              size="lg"
              dot
              onClick={() => setPickups((n) => n + 1)}
            >
              Ripple
            </Button>
          </div>
        </div>
        <figure className={s.heroDev} ref={devRef}>
          <div className={s.dbar}>
            <Pill state="live">LIVE</Pill>
            <span className={s.callee}>
              <b>Riverside Pharmacy</b>
              <span>Speaking for you</span>
            </span>
            <span className={s.timer} style={{ marginLeft: 'auto' }}>
              4:51
            </span>
          </div>
          <div className={s.heroBody}>
            <LedMatrix
              className={s.heroScreen}
              scene="live"
              data={{ name: 'YOU' }}
              level={1}
              pitch={7}
              narrowPitch={5}
              breakpoint={860}
              ring="dim"
            />
            <div />
          </div>
        </figure>
      </section>

      {/* Paper controls */}
      <section className={`${s.paperBlock} paper`} aria-label="Paper controls">
        <div>
          <p className={s.label}>How much should it do? (light segmented)</p>
          <div style={{ maxWidth: 410 }}>
            <Segmented
              options={MODES}
              value={startMode}
              onChange={setStartMode}
              label="How much should it do?"
              tone="light"
            />
          </div>
        </div>
        <div>
          <p className={s.label}>Landing fader</p>
          <div className={s.fader}>
            <Segmented
              options={MODES}
              value={fader}
              onChange={setFader}
              label="How much Carryover does"
              tone="fader"
            />
          </div>
        </div>
        <div>
          <p className={s.label}>Buttons on paper</p>
          <div className={s.row}>
            <Button variant="ink" size="lg">
              Call Riverside Pharmacy
            </Button>
            <Button variant="soft" size="lg">
              Open transcript
            </Button>
            <Button variant="ink" shape="pill" size="sm">
              Try a call
            </Button>
            <Button variant="line" shape="pill" size="lg">
              Watch a sample call
            </Button>
            <IconButton label="Close" tone="paper">
              <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M2 2l8 8M10 2l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </IconButton>
            <span>
              You can override with <Kbd tone="paper">Speak now</Kbd>
            </span>
          </div>
        </div>
      </section>

      {/* QR */}
      <section className={`${s.stage} night`} aria-label="QR codes">
        <p className={s.label}>Practice-line QR (v3 and a long tunnel URL at v4)</p>
        <div className={s.row} style={{ alignItems: 'flex-start', gap: 32 }}>
          <div className={s.qrCard}>
            <QrDots
              className={s.qr}
              text="https://carryover.app/line/ABC123"
              label="QR code that opens the Carryover practice line on your phone"
            />
          </div>
          <div className={s.qrCard}>
            <QrDots
              className={s.qr}
              text="https://silly-purple-otter-banana.trycloudflare.com/line/ABC123"
              label="QR code for a long practice-line URL"
            />
          </div>
          <QrDots
            className={s.qrSmall}
            text="https://carryover.app/line/ABC123"
            label="QR code for the practice line"
          />
        </div>
      </section>

      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="New call"
        description="Carryover calls, you read along. Change any of this later from the call screen."
        footer={
          <>
            <Button variant="ink" size="lg" onClick={() => setSheet(false)}>
              Call Riverside Pharmacy
            </Button>
            <Button variant="soft" size="lg" onClick={() => setSheet(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <p className="t-dot" style={{ fontSize: 14 }}>
          SHEET BODY
        </p>
        <div style={{ maxWidth: 410, marginTop: 16 }}>
          <Segmented
            options={MODES}
            value={startMode}
            onChange={setStartMode}
            label="How much should it do?"
            tone="light"
          />
        </div>
      </Sheet>
    </main>
  );
}
