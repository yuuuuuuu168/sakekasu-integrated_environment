import type { HealthCheckTarget } from '../../lib/health-checks';

/** 1 件の外形監視の結果 */
export interface CheckResult {
  name: string;
  ok: boolean;
  status?: number;
  /** 異常のときの説明（ログに出す） */
  detail?: string;
  durationMs: number;
}

export interface CheckOptions {
  /** 1 件あたりの待ち時間 */
  timeoutMs: number;
  /** テストで差し替える */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 監視からのアクセスだと分かるようにする。各アプリのアクセスログで見分けられる */
export const USER_AGENT = 'sakekasu-integrated-health-check';

/** 応答のステータスが期待どおりか */
export function isExpectedStatus(target: Pick<HealthCheckTarget, 'expectStatus'>, status: number): boolean {
  return target.expectStatus.includes(status);
}

/**
 * 1 件を叩いて判定する。例外は投げず、失敗も結果として返す
 * （1 件の失敗で他の対象のメトリクスまで出なくなるのを防ぐ）。
 */
export async function checkTarget(target: HealthCheckTarget, options: CheckOptions): Promise<CheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(target.url, {
      method: target.method ?? 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    // 本文は使わない。読み捨てて接続を早く返す
    await response.body?.cancel().catch(() => undefined);

    const ok = isExpectedStatus(target, response.status);
    return {
      name: target.name,
      ok,
      status: response.status,
      durationMs: now() - startedAt,
      ...(ok ? {} : { detail: `期待した応答は ${target.expectStatus.join('/')} だが ${response.status} が返った` }),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      name: target.name,
      ok: false,
      durationMs: now() - startedAt,
      detail: aborted ? `${options.timeoutMs}ms 以内に応答が無かった` : `接続できなかった: ${describeError(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** fetch の失敗は cause に本当の理由（DNS、TLS など）が入る */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? `（${cause.message}）` : '';
  return `${err.message}${causeText}`.slice(0, 300);
}

/**
 * CloudWatch に送るメトリクス。失敗は 1、成功は 0。アラームは「5 分の最大値が 1」を 2 回続けて見る。
 * 応答時間も出しておく（遅くなってきたかを後から見るため。アラームは付けていない）
 */
export function toMetricData(results: CheckResult[]) {
  return results.flatMap((result) => [
    {
      MetricName: 'HealthCheckFailed',
      Dimensions: [{ Name: 'Target', Value: result.name }],
      Value: result.ok ? 0 : 1,
      Unit: 'Count' as const,
    },
    {
      MetricName: 'HealthCheckLatency',
      Dimensions: [{ Name: 'Target', Value: result.name }],
      Value: result.durationMs,
      Unit: 'Milliseconds' as const,
    },
  ]);
}
