import { useMemo } from 'react';
import { qrMatrix } from '../led/qr';
import { LiveDot, QrDots } from '../ui';
import s from './StartCallPage.module.css';
import type { PracticeLineState } from './usePracticeLine';

const STATUS_TEXT: Record<string, string> = {
  waiting: 'WAITING FOR PHONE',
  ringing: 'RINGING',
  connected: 'PHONE CONNECTED',
  ended: 'LINE ENDED',
};

export interface PracticeBoxProps {
  line: PracticeLineState;
  onRegenerate: () => void;
}

/** The practice line's QR, code and live waiting/ringing/connected status. */
export function PracticeBox({ line, onRegenerate }: PracticeBoxProps) {
  const url = line.url;
  const drawable = useMemo(() => {
    if (!url) return false;
    try {
      qrMatrix(url);
      return true;
    } catch {
      return false;
    }
  }, [url]);

  if (line.error) {
    return (
      <div className={s.practiceBox}>
        <p className={s.practiceError}>{line.error}</p>
        <button type="button" className={s.retryLink} onClick={onRegenerate}>
          Try again
        </button>
      </div>
    );
  }

  if (line.loading || !url) {
    return (
      <div className={s.practiceBox}>
        <p className={s.practiceLoading}>Setting up your practice line…</p>
      </div>
    );
  }

  return (
    <div className={s.practiceBox}>
      {drawable ? (
        <QrDots
          className={s.qr}
          text={url}
          label="QR code for the practice line. Open it on your phone."
        />
      ) : line.qrSvg ? (
        // Fallback for a URL too long for the client QR encoder: the server's own SVG.
        <div
          className={s.qr}
          role="img"
          aria-label="QR code for the practice line. Open it on your phone."
          // biome-ignore lint/security/noDangerouslySetInnerHtml: our own server's QR SVG
          dangerouslySetInnerHTML={{ __html: line.qrSvg }}
        />
      ) : null}
      <div>
        <b>Open this on your phone</b>
        <p className={s.practiceCode}>
          Code <code>{line.code}</code>
        </p>
        <p className={s.practiceHint}>
          It rings as the practice business. Answer it on your phone to play the other side; this
          screen stays the caller.
        </p>
        {line.status && (
          <span className={s.ws}>
            <LiveDot />
            {STATUS_TEXT[line.status] ?? line.status.toUpperCase()}
          </span>
        )}
        {line.status === 'ended' && (
          <button type="button" className={s.retryLink} onClick={onRegenerate}>
            Start a new practice line
          </button>
        )}
      </div>
    </div>
  );
}
