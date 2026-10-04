import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/**
 * Lambda のログの保持期間。既定では無期限に残るので、30 日で消す。
 * アラームはメトリクス（15 か月残る）で判定するので、ログを消しても動作には影響しない。
 */
export const LAMBDA_LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

/**
 * Lambda に渡すロググループを明示して作る。作りは sakekasu-builder の lib/log-retention.ts に倣った。
 *
 * `logRetention` は非推奨で、保持期間を付けるためだけのカスタムリソースと Lambda が増える。
 * 名前は Lambda の既定と同じ `/aws/lambda/<関数名>` にして、調べるときに迷わないようにする。
 * スタックを消してもログは残す（保持期間で自然に消える）。
 *
 * @param functionName 関数の `functionName` と同じ値を渡す
 */
export function lambdaLogGroup(scope: Construct, id: string, functionName: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: LAMBDA_LOG_RETENTION,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
}
