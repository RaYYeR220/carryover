import type { UserDescriptor } from '@carryover/protocol';

/**
 * The one profile field that isn't a shareable fact: how Carryover should
 * describe you to itself (it never says this to the other side). Small
 * enough that it doesn't need the vault's IndexedDB-backed store; it lives in
 * localStorage next to the call token and caption-size prefs.
 */

const KEY = 'carryover.profile.descriptor';
export const DEFAULT_DESCRIPTOR: UserDescriptor = 'deaf';

const VALID: readonly UserDescriptor[] = [
  'deaf',
  'hard-of-hearing',
  'speech-disabled',
  'prefers-text',
];

export const DESCRIPTOR_OPTIONS: readonly { value: UserDescriptor; label: string }[] = [
  { value: 'deaf', label: 'Deaf' },
  { value: 'hard-of-hearing', label: 'Hard of hearing' },
  { value: 'speech-disabled', label: 'Speech-disabled' },
  { value: 'prefers-text', label: 'Prefers text' },
];

function isDescriptor(v: string): v is UserDescriptor {
  return (VALID as readonly string[]).includes(v);
}

export function loadDescriptor(): UserDescriptor {
  try {
    const raw = localStorage.getItem(KEY);
    return raw && isDescriptor(raw) ? raw : DEFAULT_DESCRIPTOR;
  } catch {
    return DEFAULT_DESCRIPTOR;
  }
}

export function saveDescriptor(value: UserDescriptor): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Not remembered this session, but the page still works.
  }
}
