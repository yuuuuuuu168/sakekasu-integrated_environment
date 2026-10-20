import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cachedSecureParameter, PARAMETER_CACHE_TTL_MS } from '../ssm';

/** SSM が返す値と、呼ばれた回数。テストから差し替える */
const ssm = vi.hoisted(() => ({ value: 'first' as string | undefined, calls: 0 }));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = async () => {
      ssm.calls += 1;
      return { Parameter: { Value: ssm.value } };
    };
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

/** 期限切れを起こすため Date だけ偽装する */
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('SSM の値の使い回し', () => {
  it('期限内は読み直さず、切れたら新しい値を読む', async () => {
    ssm.value = 'first';
    ssm.calls = 0;
    const read = cachedSecureParameter('/test/a', (raw) => raw);

    expect(await read()).toBe('first');
    ssm.value = 'rotated';
    expect(await read()).toBe('first');
    expect(ssm.calls).toBe(1);

    vi.setSystemTime(Date.now() + PARAMETER_CACHE_TTL_MS + 1);
    expect(await read()).toBe('rotated');
    expect(ssm.calls).toBe(2);
  });

  it('値が無ければ、パラメータ名を添えて失敗する', async () => {
    ssm.value = undefined;
    const read = cachedSecureParameter('/test/missing', (raw) => raw);
    await expect(read()).rejects.toThrow('/test/missing');
  });

  // 検証に通らなかった値を使い回すと、直したあとも期限まで失敗し続ける
  it('parse が失敗した値は使い回さない', async () => {
    ssm.value = 'broken';
    ssm.calls = 0;
    const read = cachedSecureParameter('/test/b', (raw) => {
      if (raw === 'broken') throw new Error('読めません');
      return raw;
    });

    await expect(read()).rejects.toThrow('読めません');
    ssm.value = 'fixed';
    expect(await read()).toBe('fixed');
    expect(ssm.calls).toBe(2);
  });
});
