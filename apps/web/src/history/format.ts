/** "Sep 28, 2026, 3:14 PM" — the browser's locale, medium date + short time. */
export function fmtDateTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(ms),
    );
  } catch {
    return new Date(ms).toLocaleString();
  }
}
