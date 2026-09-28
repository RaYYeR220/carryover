/** Icons from Glyph Night's call screen. All decorative. */

export const HangUpIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path
      d="M3.4 14.6c4.8-4.1 12.4-4.1 17.2 0l-1.9 2.6c-.3.4-.9.5-1.3.3l-2.6-1.3a1 1 0 0 1-.5-1.1l.3-1.5a10 10 0 0 0-5.2 0l.3 1.5a1 1 0 0 1-.5 1.1l-2.6 1.3c-.4.2-1 .1-1.3-.3z"
      fill="currentColor"
    />
  </svg>
);

export const SendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 19V5M5 12l7-7 7 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const CalendarIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect
      x="3.5"
      y="5"
      width="17"
      height="15"
      rx="3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const BuzzIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <rect
      x="8"
      y="3"
      width="8"
      height="18"
      rx="2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    />
    <path
      d="M4 8v8M20 8v8M1.5 10v4M22.5 10v4"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

export const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M2 6.5l2.5 2.5L10 3.5"
      fill="none"
      stroke="#fff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
