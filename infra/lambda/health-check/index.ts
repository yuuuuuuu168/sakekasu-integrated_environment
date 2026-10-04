import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { parseHealthChecks } from '../../lib/health-checks';
import { checkTarget, toMetricData, type CheckResult } from './check';

/**
 * 外形監視。5 分ごとに各サイトを叩き、結果をメトリクスにする。作りは sakekasu-builder の
 * lambda/health-check に倣った。しきい値と連続回数はアラーム側（monitoring-stack.ts）で決める。
 *
 * 対象は CDK から JSON の環境変数で受ける。読み込み時に確かめるので、壊れていれば初期化で落ち、
 * Lambda のエラーとして「監視の監視」のアラームに出る。ハンドラの中で落とすと
 * 「メトリクスが出ないだけ」になり、欠損を異常なしとみなすアラームでは見逃す。
 */
const METRIC_NAMESPACE = requiredEnv('METRIC_NAMESPACE');
const TARGETS = parseHealthChecks(JSON.parse(requiredEnv('HEALTH_CHECK_TARGETS')));
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? '10000');

const cloudwatch = new CloudWatchClient({});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が無い`);
  return value;
}

export const handler = async (): Promise<{ results: CheckResult[] }> => {
  const results = await Promise.all(TARGETS.map((target) => checkTarget(target, { timeoutMs: TIMEOUT_MS })));

  await cloudwatch.send(
    new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: toMetricData(results) }),
  );

  for (const result of results) {
    if (!result.ok) {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          action: 'healthCheck',
          target: result.name,
          status: result.status,
          detail: result.detail,
        }),
      );
    }
  }

  return { results };
};
