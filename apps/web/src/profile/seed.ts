import type { Fact } from '@carryover/protocol';
import { vault } from '../lib/store';

/**
 * The vault's starting facts, so a first-time visitor has something to look
 * at and to share on a call. Seeded once: if the vault already has anything
 * in it (including after the user deleted every default fact), nothing is
 * added back.
 */
export const DEFAULT_FACTS: readonly Fact[] = [
  { key: 'name', label: 'Name', value: 'Maya Chen' },
  { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
  { key: 'address', label: 'Address', value: '41 Alder Street, Portland OR 97205' },
  { key: 'member_id', label: 'Member ID', value: '40718233' },
];

let seeding: Promise<void> | null = null;

/** Seeds `DEFAULT_FACTS` into the vault the first time it's ever empty. Safe to call from every page that reads the vault; runs once per session. */
export function ensureSeeded(): Promise<void> {
  seeding ??= (async () => {
    try {
      const existing = await vault.list();
      if (existing.length > 0) return;
      for (const fact of DEFAULT_FACTS) await vault.save(fact);
    } catch {
      // The vault falls back to memory on its own; a seed failure just means
      // an empty profile, which the pages already handle.
    }
  })();
  return seeding;
}

/** Test-only: forget that seeding ran, so the next `ensureSeeded()` checks the vault again. */
export function resetSeedState(): void {
  seeding = null;
}
