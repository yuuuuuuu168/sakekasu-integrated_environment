import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { PREFIX, ROLE_BOUNDARY_NAME } from './names';

/**
 * 監視の Lambda やイベント転送のロールに付ける Permissions Boundary。作りは sakekasu-builder の
 * lib/role-boundary.ts に倣った（向こうの Issue #150）。
 *
 * cdkd 用ロールは、監視のスタックが使うロールを作り替える必要がある。ロール名を
 * `sakekasu-integrated-app-*` に閉じても、それだけでは権限昇格を塞げない。
 *
 *   1. `iam:PutRolePolicy` で Lambda の実行ロールに管理者相当を書き込む
 *   2. その関数のコードを差し替えて呼ぶ
 *
 * これで main への push を起点に任意の API を叩ける。境界を付けると、ロールの実効権限は
 * 「アイデンティティポリシー ∩ 境界」になるので、1 で何を書き込まれても境界の外には出られない。
 *
 * builder の境界は「全部許して IAM と STS だけ抜く」形だが、こちらは監視の Lambda と
 * イベント転送しか作らないので、要る操作だけを並べた許可リストにしている。境界の外に出る
 * 操作を Lambda に足すと、デプロイは通っても実行時に AccessDenied になる。そのときはここに足す。
 */

/** 指定アカウントでの境界ポリシーの ARN */
export function roleBoundaryArn(account: string, partition = 'aws'): string {
  return `arn:${partition}:iam::${account}:policy/${ROLE_BOUNDARY_NAME}`;
}

/**
 * 境界ポリシーの本体を作る。`CdkdDeployStack`（CloudFormation で入れるスタック）からだけ呼ぶ。
 *
 * 監視のスタックより先に存在している必要がある。境界が無いと、cdkd 用ロールの
 * `iam:CreateRole` が条件に合わず AccessDenied になる。deploy ワークフローは
 * cdkd-deploy スタックを先に入れるので、この順序は保たれる。
 */
export function createRoleBoundary(scope: Construct, id: string): iam.ManagedPolicy {
  const { account } = cdk.Stack.of(scope);
  // パーティションは aws に固定する（cdkd-monitoring-statements.ts と同じ）
  const partition = 'aws';

  return new iam.ManagedPolicy(scope, id, {
    managedPolicyName: ROLE_BOUNDARY_NAME,
    // IAM の description は ASCII + Latin-1 のみ
    description: 'Ceiling for sakekasu-integrated app roles created by cdkd (monitoring only)',
    statements: [
      // Lambda のログ。ロググループはスタックで明示して作るので、書き込みだけ
      new iam.PolicyStatement({
        sid: 'WriteOwnLambdaLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:${partition}:logs:*:${account}:log-group:/aws/lambda/${PREFIX}-*`],
      }),
      // Slack の Webhook URL。SecureString の復号は AWS 管理キー（aws/ssm）なので kms の許可は要らない
      new iam.PolicyStatement({
        sid: 'ReadOwnParameters',
        actions: ['ssm:GetParameter'],
        resources: [`arn:${partition}:ssm:*:${account}:parameter/${PREFIX}/*`],
      }),
      // 外形監視の結果。名前空間はこのリポジトリのものだけ
      new iam.PolicyStatement({
        sid: 'PutOwnMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringLike: { 'cloudwatch:namespace': `${PREFIX}*` } },
      }),
      new iam.PolicyStatement({
        sid: 'PublishOwnTopics',
        actions: ['sns:Publish'],
        resources: [`arn:${partition}:sns:*:${account}:${PREFIX}-*`],
      }),
      // グローバルの AWS Health を ap-northeast-1 の default バスへ転送する
      new iam.PolicyStatement({
        sid: 'ForwardToDefaultBus',
        actions: ['events:PutEvents'],
        resources: [`arn:${partition}:events:*:${account}:event-bus/default`],
      }),
      // いまは使っていないが、Lambda のトレースを有効にしたときに要る
      new iam.PolicyStatement({
        sid: 'Tracing',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
      // 上の許可リストを将来ワイルドカードに広げても、昇格に使えるものには届かないようにする
      new iam.PolicyStatement({
        sid: 'DenyIdentityAndOrganizationControl',
        effect: iam.Effect.DENY,
        actions: ['iam:*', 'sts:*', 'organizations:*', 'account:*'],
        resources: ['*'],
      }),
    ],
  });
}

/**
 * スタック内で作られるロールすべてに境界を付ける。CDK が裏で作るロールにも効く。
 *
 * GitHub Actions のロールのスタック（github-oidc、cdkd-deploy）には付けない。
 * cdkd 用ロール自身に付くと IAM が拒否され、監視のロールを作れなくなる。
 */
export function applyRoleBoundary(stack: cdk.Stack): void {
  const boundary = iam.ManagedPolicy.fromManagedPolicyName(stack, 'RoleBoundary', ROLE_BOUNDARY_NAME);
  iam.PermissionsBoundary.of(stack).apply(boundary);
}
