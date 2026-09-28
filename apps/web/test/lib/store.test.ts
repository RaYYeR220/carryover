import type { CallSummary } from '@carryover/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCallToken,
  createHistory,
  createVault,
  type HistoryEntry,
  type KV,
  loadCallToken,
  memoryKv,
  resilientKv,
  saveCallToken,
} from '../../src/lib/store';

const summary = (callId: string, startedAt: number): CallSummary => ({
  callId,
  startedAt,
  endedAt: startedAt + 60_000,
  targetLabel: 'Riverside Pharmacy',
  outcome: 'Refill ready Thursday',
  bullets: ['Ready after 2 pm'],
  commitments: [{ text: 'Pick up lisinopril', when: 'Thursday after 2 pm' }],
  transcript: [],
});

const entry = (callId: string, startedAt: number): HistoryEntry => ({
  ...summary(callId, startedAt),
  target: { kind: 'scenario', scenarioId: 'riverside-pharmacy' },
  mode: 'assist',
});

describe('vault', () => {
  it('starts empty, then upserts facts by key in insertion order', async () => {
    const vault = createVault(memoryKv());
    expect(await vault.list()).toEqual([]);
    await vault.save({ key: 'name', label: 'Name', value: 'Maya Collins' });
    await vault.save({ key: 'dob', label: 'Date of birth', value: 'March 14, 1952' });
    await vault.save({ key: 'name', label: 'Name', value: 'Maya C.' });
    expect(await vault.list()).toEqual([
      { key: 'name', label: 'Name', value: 'Maya C.' },
      { key: 'dob', label: 'Date of birth', value: 'March 14, 1952' },
    ]);
  });

  it('removes facts by key', async () => {
    const vault = createVault(memoryKv());
    await vault.save({ key: 'name', label: 'Name', value: 'Maya' });
    await vault.save({ key: 'dob', label: 'Date of birth', value: 'March 14, 1952' });
    await vault.remove('name');
    await vault.remove('missing');
    expect((await vault.list()).map((f) => f.key)).toEqual(['dob']);
  });

  it('trims and validates facts against the protocol limits', async () => {
    const vault = createVault(memoryKv());
    await vault.save({ key: ' addr ', label: ' Address ', value: ' 18 Alder St ' });
    expect(await vault.list()).toEqual([{ key: 'addr', label: 'Address', value: '18 Alder St' }]);
    await expect(vault.save({ key: 'x', label: 'X', value: '   ' })).rejects.toThrow(RangeError);
    await expect(vault.save({ key: 'x', label: 'X', value: 'v'.repeat(201) })).rejects.toThrow(
      RangeError,
    );
    await expect(vault.save({ key: 'k'.repeat(41), label: 'X', value: 'v' })).rejects.toThrow(
      RangeError,
    );
  });

  it('returns copies, so callers cannot mutate stored state', async () => {
    const vault = createVault(memoryKv());
    await vault.save({ key: 'name', label: 'Name', value: 'Maya' });
    const list = await vault.list();
    list.pop();
    expect(await vault.list()).toHaveLength(1);
  });
});

describe('history', () => {
  let history: ReturnType<typeof createHistory>;
  beforeEach(() => {
    history = createHistory(memoryKv());
  });

  it('lists calls newest first and gets one by id', async () => {
    await history.save(entry('a', 1000));
    await history.save(entry('b', 3000));
    await history.save(entry('c', 2000));
    expect((await history.list()).map((e) => e.callId)).toEqual(['b', 'c', 'a']);
    expect(await history.get('c')).toMatchObject({ callId: 'c', mode: 'assist' });
    expect(await history.get('zzz')).toBeUndefined();
  });

  it('replaces an entry saved twice for the same call', async () => {
    await history.save(entry('a', 1000));
    await history.save({ ...entry('a', 1000), outcome: 'Updated' });
    const all = await history.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.outcome).toBe('Updated');
  });

  it('keeps target and mode alongside the summary', async () => {
    await history.save({
      ...entry('p', 1),
      target: { kind: 'line', code: 'ABC123' },
      mode: 'relay',
    });
    expect(await history.get('p')).toMatchObject({
      target: { kind: 'line', code: 'ABC123' },
      mode: 'relay',
    });
  });

  it('caps history at the most recent 200 calls', async () => {
    for (let i = 0; i < 205; i++) await history.save(entry(`c${i}`, i));
    const all = await history.list();
    expect(all).toHaveLength(200);
    expect(all.at(-1)?.callId).toBe('c5');
  });

  it('removes an entry by call id', async () => {
    await history.save(entry('a', 1000));
    await history.save(entry('b', 2000));
    await history.remove('a');
    await history.remove('missing');
    expect((await history.list()).map((e) => e.callId)).toEqual(['b']);
  });
});

describe('resilientKv', () => {
  it('retries a failing primary on the fallback and keeps using it', async () => {
    let primaryCalls = 0;
    const primary: KV = {
      get: async () => {
        primaryCalls++;
        throw new Error('idb broken');
      },
      update: async () => {
        primaryCalls++;
        throw new Error('idb broken');
      },
    };
    const fallback = memoryKv();
    const kv = resilientKv([() => primary, () => fallback]);

    await kv.update('k', () => 'v1');
    expect(await kv.get('k')).toBe('v1');
    // Only the first operation should have touched the broken primary; once
    // swapped, later calls go straight to the fallback.
    await kv.update('k', () => 'v2');
    expect(await kv.get('k')).toBe('v2');
    expect(primaryCalls).toBe(1);
  });

  it('falls all the way to memory when every real backend fails', async () => {
    const broken = (): KV => ({
      get: async () => {
        throw new Error('down');
      },
      update: async () => {
        throw new Error('down');
      },
    });
    const kv = resilientKv([broken, broken, memoryKv]);
    await kv.update('k', () => 'ok');
    expect(await kv.get('k')).toBe('ok');
  });

  it('a factory that throws while constructing is also skipped', async () => {
    const kv = resilientKv([
      () => {
        throw new Error('indexedDB unavailable');
      },
      memoryKv,
    ]);
    await kv.update('k', () => 'v');
    expect(await kv.get('k')).toBe('v');
  });

  it('vault and history keep working when their kv fails at runtime', async () => {
    const primary: KV = {
      get: async () => {
        throw new Error('transaction aborted');
      },
      update: async () => {
        throw new Error('transaction aborted');
      },
    };
    const kv = resilientKv([() => primary, memoryKv]);
    const vault = createVault(kv);
    await vault.save({ key: 'name', label: 'Name', value: 'Maya Chen' });
    expect(await vault.list()).toEqual([{ key: 'name', label: 'Name', value: 'Maya Chen' }]);

    const hist = createHistory(kv);
    await hist.save(entry('z', 1));
    expect(await hist.get('z')).toMatchObject({ callId: 'z' });
  });
});

describe('call tokens', () => {
  it('stores the app token in sessionStorage per call', () => {
    saveCallToken('c1', 'tok');
    expect(sessionStorage.getItem('carryover.token.c1')).toBe('tok');
    expect(loadCallToken('c1')).toBe('tok');
    expect(loadCallToken('c2')).toBeNull();
    clearCallToken('c1');
    expect(loadCallToken('c1')).toBeNull();
  });
});
