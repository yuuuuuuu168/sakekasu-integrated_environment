import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthCheckTarget } from '../../../lib/health-checks';
import { USER_AGENT, checkTarget, isExpectedStatus, toMetricData } from '../check';

const target: HealthCheckTarget = {
  name: 'builder',
  url: 'https://example.com/',
  method: 'GET',
  expectStatus: [200],
};

/** 指定したステータスを返す fetch の代わり。呼ばれ方も記録する */
function fakeFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('ステータスの判定', () => {
  it('期待したステータスなら正常', () => {
    expect(isExpectedStatus({ expectStatus: [200] }, 200)).toBe(true);
    expect(isExpectedStatus({ expectStatus: [200, 204] }, 204)).toBe(true);
  });

  it('それ以外は異常（5xx も 4xx も 3xx も）', () => {
    for (const status of [500, 503, 403, 404, 301]) {
      expect(isExpectedStatus({ expectStatus: [200] }, status)).toBe(false);
    }
  });
});

describe('1 件の外形監視', () => {
  it('200 が返れば正常', async () => {
    const { impl } = fakeFetch(200);
    const result = await checkTarget(target, { timeoutMs: 1000, fetchImpl: impl });
    expect(result).toMatchObject({ name: 'builder', ok: true, status: 200 });
    expect(result.detail).toBeUndefined();
  });

  it('期待と違うステータスなら異常で、理由を残す', async () => {
    const { impl } = fakeFetch(503);
    const result = await checkTarget(target, { timeoutMs: 1000, fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(result.detail).toContain('503');
  });

  it('接続できなければ例外を投げず、異常として返す', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND example.com') });
    }) as unknown as typeof fetch;
    const result = await checkTarget(target, { timeoutMs: 1000, fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('時間内に応答が無ければ打ち切って異常にする', async () => {
    // signal が中断されるまで返らない fetch
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    const result = await checkTarget(target, { timeoutMs: 20, fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('20ms');
  });

  it('指定したメソッドで叩き、リダイレクトは追い、監視だと分かる User-Agent を付ける', async () => {
    const { impl, calls } = fakeFetch(200);
    await checkTarget({ ...target, method: 'HEAD' }, { timeoutMs: 1000, fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/');
    expect(calls[0].init.method).toBe('HEAD');
    expect(calls[0].init.redirect).toBe('follow');
    expect((calls[0].init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
  });

  it('応答時間を測る', async () => {
    const { impl } = fakeFetch(200);
    let t = 1000;
    const result = await checkTarget(target, {
      timeoutMs: 1000,
      fetchImpl: impl,
      now: () => {
        const v = t;
        t += 150;
        return v;
      },
    });
    expect(result.durationMs).toBe(150);
  });
});

describe('メトリクス', () => {
  it('失敗は 1、成功は 0 を対象ごとの次元で出す', () => {
    const data = toMetricData([
      { name: 'builder', ok: true, status: 200, durationMs: 120 },
      { name: 'auth', ok: false, status: 500, durationMs: 80 },
    ]);
    const failed = data.filter((d) => d.MetricName === 'HealthCheckFailed');
    expect(failed).toEqual([
      { MetricName: 'HealthCheckFailed', Dimensions: [{ Name: 'Target', Value: 'builder' }], Value: 0, Unit: 'Count' },
      { MetricName: 'HealthCheckFailed', Dimensions: [{ Name: 'Target', Value: 'auth' }], Value: 1, Unit: 'Count' },
    ]);
    const latency = data.filter((d) => d.MetricName === 'HealthCheckLatency');
    expect(latency.map((d) => d.Value)).toEqual([120, 80]);
  });
});

describe('ハンドラ', () => {
  const sent: unknown[] = [];

  beforeEach(() => {
    sent.length = 0;
    vi.resetModules();
    vi.doMock('@aws-sdk/client-cloudwatch', () => ({
      CloudWatchClient: class {
        send = async (command: { input: unknown }) => {
          sent.push(command.input);
          return {};
        };
      },
      PutMetricDataCommand: class {
        constructor(public input: unknown) {}
      },
    }));
    process.env.METRIC_NAMESPACE = 'test-namespace';
    process.env.TIMEOUT_MS = '1000';
  });

  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-cloudwatch');
    vi.unstubAllGlobals();
    delete process.env.HEALTH_CHECK_TARGETS;
  });

  it('全対象を叩いてメトリクスを 1 回で送る。1 件落ちても他は出す', async () => {
    process.env.HEALTH_CHECK_TARGETS = JSON.stringify([
      { name: 'ok-site', url: 'https://ok.example/', expectStatus: [200] },
      { name: 'down-site', url: 'https://down.example/', expectStatus: [200] },
    ]);
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://down.')) throw new TypeError('fetch failed');
      return new Response(null, { status: 200 });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handler } = await import('../index');
      const { results } = await handler();
      expect(results.map((r) => [r.name, r.ok])).toEqual([
        ['ok-site', true],
        ['down-site', false],
      ]);
      expect(sent).toHaveLength(1);
      const input = sent[0] as { Namespace: string; MetricData: Array<{ MetricName: string; Value: number }> };
      expect(input.Namespace).toBe('test-namespace');
      expect(input.MetricData.filter((d) => d.MetricName === 'HealthCheckFailed').map((d) => d.Value)).toEqual([0, 1]);
      // 異常はログにも残す（どの対象が、なぜ落ちたか）
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toContain('down-site');
    } finally {
      errors.mockRestore();
    }
  });

  // 設定が壊れていれば初期化で落ちる。Lambda のエラーになり「監視の監視」に出る
  it('対象の設定が壊れていれば読み込みで落ちる', async () => {
    process.env.HEALTH_CHECK_TARGETS = JSON.stringify([{ name: 'x', url: 'http://insecure.example/' }]);
    await expect(import('../index')).rejects.toThrow(/https/);
  });

  it('対象の設定が無ければ読み込みで落ちる', async () => {
    await expect(import('../index')).rejects.toThrow(/HEALTH_CHECK_TARGETS/);
  });
});
