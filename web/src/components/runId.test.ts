import { afterEach, describe, expect, it } from 'vitest';
import { generateRunId } from './runId';

/** Replace `crypto`, returning a restore function — same shape as clipboard.test.ts's `withClipboard`. */
function withCrypto(value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  };
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe('generateRunId', () => {
  it('uses crypto.randomUUID where it exists', () => {
    restore = withCrypto({ randomUUID: () => 'fixed-uuid' });
    expect(generateRunId()).toBe('fixed-uuid');
  });

  it('falls back to getRandomValues when randomUUID is ABSENT, which is the HTTP case', () => {
    // The regression this file exists for. The gateway is served over plain
    // HTTP, so `crypto.randomUUID` is `undefined` there, and the previous code
    // called it directly — which threw, rather than silently doing nothing,
    // and the Run button did nothing at all. Measured on the rig 28/09/2026.
    restore = withCrypto({
      getRandomValues: (arr: Uint8Array) => { arr.fill(0xab); return arr; },
    });
    const id = generateRunId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('falls back to getRandomValues when randomUUID THROWS rather than being absent', () => {
    restore = withCrypto({
      randomUUID: () => { throw new Error('not a secure context'); },
      getRandomValues: (arr: Uint8Array) => { arr.fill(0x11); return arr; },
    });
    expect(generateRunId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to a plain string when crypto does not exist at all', () => {
    restore = withCrypto(undefined);
    expect(generateRunId()).toMatch(/^run-/);
  });

  it('never returns the same id twice from the getRandomValues fallback', () => {
    restore = withCrypto({
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    });
    expect(generateRunId()).not.toBe(generateRunId());
  });
});
