import * as iam from 'aws-cdk-lib/aws-iam';
import { roleBoundaryArn } from './role-boundary';
import { APP_ROLE_PREFIX, CDKD_DEPLOY_ROLE_NAME, DEPLOY_ROLE_NAME, PREFIX, ROLE_BOUNDARY_NAME } from './names';

/** cdkd が触ってよいリージョン（cdkd-deploy-stack.ts と同じ） */
const REGIONS = ['ap-northeast-1', 'us-east-1'];

/** ロールを渡してよいサービス。監視の Lambda と、Health の転送ルールだけ */
export const PASS_ROLE_TARGET_SERVICES = ['lambda.amazonaws.com', 'events.amazonaws.com'];

/**
 * ロールの権限を書き換える操作。どれも iam:PermissionsBoundary の条件キーが効く。
 * 境界の付いたロールにだけ許し、境界の無いロールには Deny する
 */
export const BOUNDED_ROLE_WRITE_ACTIONS = [
  'iam:CreateRole',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:PutRolePermissionsBoundary',
];

/**
 * 監視のスタック（monitoring、health-global）を cdkd でデプロイするための権限（IAM 以外）。
 * cdkd-deploy-stack.ts の管理ポリシーとは別の管理ポリシーに入れる。1 つの管理ポリシーは
 * 空白を除いて 6,144 文字までで、まとめると超える（deploy-roles.test.ts で見ている）。
 *
 * 列挙した操作は、cdkd 0.291.16 の各リソースの実装（SNS・Lambda・Logs・CloudWatch・
 * EventBridge・IAM）が呼ぶ API を node_modules/@go-to-k/cdkd/dist から拾ったもの。
 * builder はサービス単位のワイルドカードで許しているが、こちらは列挙して名前でも絞る。
 * 足りなければデプロイの途中で AccessDenied で落ちるので、そのたびに足す。
 *
 * リソースは名前が `sakekasu-integrated-` で始まるものに絞る。ロールだけはさらに
 * `sakekasu-integrated-app-` に絞り、GitHub Actions のロールを範囲から外している。
 */
export function cdkdMonitoringStatements(account: string): iam.PolicyStatement[] {
  // 読みやすさとテストのため、パーティションは aws に固定する（このアカウントは商用リージョンだけ）
  const partition = 'aws';
  const regionCondition = { StringEquals: { 'aws:RequestedRegion': REGIONS } };

  return [
    // --- Lambda（Slack 通知と外形監視）---
    new iam.PolicyStatement({
      sid: 'ManageMonitoringFunctions',
      actions: [
        'lambda:CreateFunction',
        'lambda:DeleteFunction',
        'lambda:GetFunction',
        'lambda:GetFunctionConfiguration',
        'lambda:UpdateFunctionCode',
        'lambda:UpdateFunctionConfiguration',
        'lambda:GetFunctionCodeSigningConfig',
        'lambda:PutFunctionCodeSigningConfig',
        'lambda:DeleteFunctionCodeSigningConfig',
        'lambda:GetFunctionConcurrency',
        'lambda:PutFunctionConcurrency',
        'lambda:DeleteFunctionConcurrency',
        'lambda:GetFunctionRecursionConfig',
        'lambda:PutFunctionRecursionConfig',
        'lambda:GetRuntimeManagementConfig',
        'lambda:PutRuntimeManagementConfig',
        'lambda:ListTags',
        'lambda:TagResource',
        'lambda:UntagResource',
        // SNS と EventBridge から呼ばれるための許可（AWS::Lambda::Permission）
        'lambda:AddPermission',
        'lambda:RemovePermission',
        'lambda:GetPolicy',
      ],
      resources: [`arn:${partition}:lambda:*:${account}:function:${PREFIX}-*`],
      conditions: regionCondition,
    }),

    // --- SNS（通知先のトピック）---
    // sns:Publish は入れない。デプロイには要らない
    new iam.PolicyStatement({
      sid: 'ManageAlertTopic',
      actions: [
        'sns:CreateTopic',
        'sns:DeleteTopic',
        'sns:GetTopicAttributes',
        'sns:SetTopicAttributes',
        'sns:ListSubscriptionsByTopic',
        'sns:Subscribe',
        'sns:Unsubscribe',
        'sns:GetSubscriptionAttributes',
        'sns:SetSubscriptionAttributes',
        'sns:ListTagsForResource',
        'sns:TagResource',
        'sns:UntagResource',
      ],
      // 購読の ARN はトピックの ARN のうしろに ID が付く形なので、同じ接頭辞で拾える
      resources: [`arn:${partition}:sns:*:${account}:${PREFIX}-*`],
      conditions: regionCondition,
    }),

    // --- EventBridge（AWS Health のルール、外形監視のスケジュール、us-east-1 の転送）---
    new iam.PolicyStatement({
      sid: 'ManageMonitoringRules',
      actions: [
        'events:PutRule',
        'events:DeleteRule',
        'events:DescribeRule',
        'events:EnableRule',
        'events:DisableRule',
        'events:PutTargets',
        'events:RemoveTargets',
        'events:ListTargetsByRule',
        'events:ListTagsForResource',
        'events:TagResource',
        'events:UntagResource',
      ],
      resources: [`arn:${partition}:events:*:${account}:rule/${PREFIX}-*`],
      conditions: regionCondition,
    }),

    // --- CloudWatch アラーム ---
    new iam.PolicyStatement({
      sid: 'ManageMonitoringAlarms',
      actions: [
        'cloudwatch:PutMetricAlarm',
        'cloudwatch:DeleteAlarms',
        'cloudwatch:EnableAlarmActions',
        'cloudwatch:DisableAlarmActions',
        'cloudwatch:ListTagsForResource',
        'cloudwatch:TagResource',
        'cloudwatch:UntagResource',
      ],
      resources: [`arn:${partition}:cloudwatch:*:${account}:alarm:${PREFIX}-*`],
      conditions: regionCondition,
    }),

    // --- CloudWatch Logs（Lambda のロググループ。保持 30 日）---
    // ログの中身を読む操作（GetLogEvents、FilterLogEvents など）は入れない
    new iam.PolicyStatement({
      sid: 'ManageMonitoringLogGroups',
      actions: [
        'logs:CreateLogGroup',
        'logs:DeleteLogGroup',
        'logs:PutRetentionPolicy',
        'logs:DeleteRetentionPolicy',
        'logs:ListTagsForResource',
        'logs:ListTagsLogGroup',
        'logs:TagResource',
        'logs:UntagResource',
        'logs:TagLogGroup',
        'logs:UntagLogGroup',
        'logs:GetDataProtectionPolicy',
        'logs:DescribeIndexPolicies',
      ],
      resources: [
        `arn:${partition}:logs:*:${account}:log-group:/aws/lambda/${PREFIX}-*`,
        `arn:${partition}:logs:*:${account}:log-group:/aws/lambda/${PREFIX}-*:*`,
      ],
      conditions: regionCondition,
    }),

    // 一覧の読み取りは名前で絞れない（どれも読み取りだけ）
    new iam.PolicyStatement({
      sid: 'ListMonitoringResources',
      actions: ['sns:ListTopics', 'cloudwatch:DescribeAlarms', 'logs:DescribeLogGroups'],
      resources: ['*'],
      conditions: regionCondition,
    }),

    /*
     * cdkd のアセット（Lambda のコード）。
     *
     * cdkd は状態バケットの `cdkd-bootstrap/<region>.json`（`cdkd bootstrap` が書く印）を見て、
     * 印があれば cdkd 自身の置き場所 `cdkd-assets-<account>-<region>` に上げる。無ければ CDK の
     * bootstrap バケット（cdk-hnb659fds-assets-*）に、ロールを引き受けずに自分の権限で上げる。
     * 同じアカウントの kakeibo の deploy ワークフローが ap-northeast-1 と us-east-1 の両方で
     * `cdkd bootstrap` を済ませているので、こちらは前者だけを許す。印が無いときは deploy
     * ワークフローの手前の検査で止める（.github/workflows/deploy.yml）。
     *
     * 置き場所の確認は HeadBucket（s3:ListBucket）と、コンテナ用の ECR リポジトリの
     * DescribeRepositories。上げる前に HeadObject（s3:GetObject）で有無を見て、無ければ PutObject。
     * Lambda の作成・更新では、Lambda が呼び出し元の権限でコードを読むので s3:GetObject が要る。
     *
     * バケットは kakeibo・learning と共用。キーは中身のハッシュなので、名前で絞れない。
     */
    new iam.PolicyStatement({
      sid: 'CdkdAssetBucket',
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: REGIONS.map((r) => `arn:${partition}:s3:::cdkd-assets-${account}-${r}`),
    }),
    new iam.PolicyStatement({
      sid: 'CdkdAssetObjects',
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: REGIONS.map((r) => `arn:${partition}:s3:::cdkd-assets-${account}-${r}/*`),
    }),
    new iam.PolicyStatement({
      sid: 'CdkdAssetRepository',
      actions: ['ecr:DescribeRepositories'],
      resources: REGIONS.map((r) => `arn:${partition}:ecr:${r}:${account}:repository/cdkd-container-assets-${account}-${r}`),
    }),
  ];
}

/**
 * 監視のスタックが使うロール（`sakekasu-integrated-app-*`）を作るための IAM の権限。
 * 上の cdkdMonitoringStatements とは別の管理ポリシーに入れる（文字数の上限のため）。
 */
export function cdkdAppRoleStatements(account: string): iam.PolicyStatement[] {
  const partition = 'aws';
  const appRoleArn = `arn:${partition}:iam::${account}:role/${APP_ROLE_PREFIX}*`;
  const boundaryArn = roleBoundaryArn(account, partition);

  return [
    /*
     * IAM: 監視の Lambda と転送ルールのロール。
     *
     * 権限を書き換える操作は、対象のロールに境界（sakekasu-integrated-role-boundary）が
     * 付いていることを条件にする。境界の無いロールは作れず、境界の付いたロールに管理者相当を
     * 書き込んでも実効権限は境界で頭打ちになるので、「ロールに書き込む → その権限で動かす」
     * という昇格の連鎖が切れる。
     *
     * 条件を付けられるのは iam:PermissionsBoundary が効く操作だけ。TagRole などに付けると
     * キーが渡らず常に不一致になり、恒久的な AccessDenied になる。
     */
    new iam.PolicyStatement({
      sid: 'ManageAppRolesWithinBoundary',
      actions: BOUNDED_ROLE_WRITE_ACTIONS,
      resources: [appRoleArn],
      conditions: { ArnEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    }),
    /*
     * 読み取り・削除と、権限に影響しない属性の変更。iam:PermissionsBoundary が渡らない操作なので
     * 条件は付けない（DeleteRole もこのキーの対象に入っていない）。ロールを消しても権限は増えない。
     *
     * iam:UpdateAssumeRolePolicy は入れない。信頼ポリシーを書き換えると「誰がそのロールになれるか」
     * を変えられ、外のアカウントからロールの権限をそのまま使える。cdkd がこれを使うのは CDK 側で
     * assumedBy を変えたときだけで、そのときは AccessDenied で止まるので人が手で直す
     */
    new iam.PolicyStatement({
      sid: 'ReadAndDescribeAppRoles',
      actions: [
        'iam:GetRole',
        'iam:DeleteRole',
        'iam:GetRolePolicy',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
        'iam:ListRoleTags',
        'iam:ListInstanceProfilesForRole',
        'iam:UpdateRole',
        'iam:UpdateRoleDescription',
        'iam:TagRole',
        'iam:UntagRole',
      ],
      resources: [appRoleArn],
    }),
    // iam:PassedToService は PassRole にしか効かないので、文を分ける
    new iam.PolicyStatement({
      sid: 'PassAppRolesToKnownServices',
      actions: ['iam:PassRole'],
      resources: [appRoleArn],
      conditions: { StringEquals: { 'iam:PassedToService': PASS_ROLE_TARGET_SERVICES } },
    }),

    // 境界の無いロールの作成・書き換えを、許可の書き方によらず塞ぐ。
    // 上の Allow を将来うっかり広げても、ここが残っていれば境界の外のロールは生まれない
    new iam.PolicyStatement({
      sid: 'DenyRoleWritesWithoutBoundary',
      effect: iam.Effect.DENY,
      actions: BOUNDED_ROLE_WRITE_ACTIONS,
      resources: ['*'],
      conditions: { ArnNotEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    }),
    // 境界を外されると上の条件が意味を失う
    new iam.PolicyStatement({
      sid: 'DenyRemovingBoundary',
      effect: iam.Effect.DENY,
      actions: ['iam:DeleteRolePermissionsBoundary', 'iam:DeleteUserPermissionsBoundary'],
      resources: ['*'],
    }),
    // 境界の中身の書き換えと削除。境界は CloudFormation（cdkd-deploy スタック）だけが管理する
    new iam.PolicyStatement({
      sid: 'DenyRewritingBoundary',
      effect: iam.Effect.DENY,
      actions: [
        'iam:CreatePolicyVersion',
        'iam:DeletePolicyVersion',
        'iam:SetDefaultPolicyVersion',
        'iam:DeletePolicy',
        'iam:TagPolicy',
        'iam:UntagPolicy',
      ],
      resources: [`arn:${partition}:iam::${account}:policy/${ROLE_BOUNDARY_NAME}`],
    }),
    // GitHub Actions のロールは触らせない。名前の範囲から外してあるが、念のため明示する
    new iam.PolicyStatement({
      sid: 'DenyTamperingWithDeployRoles',
      effect: iam.Effect.DENY,
      actions: ['iam:*'],
      resources: [
        `arn:${partition}:iam::${account}:role/${DEPLOY_ROLE_NAME}`,
        `arn:${partition}:iam::${account}:role/${CDKD_DEPLOY_ROLE_NAME}`,
      ],
    }),
  ];
}
