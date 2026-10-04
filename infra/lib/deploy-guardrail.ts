import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * cdkd 用ロールに付けるガードレール（Deny だけの管理ポリシー）。
 *
 * 4 アプリ（reinvent、builder、kakeibo、learning）と共通基盤は同じアカウントに同居している。
 * cdkd が誤った差分を出したとき（2026-10-04 にはタグを足しただけでロールの作り直しが起き、
 * 古いロールのポリシーが剥がされた）に、
 * 壊れるのをこのアプリの中に留めるのが目的。
 *
 * 共通基盤の cdkd 用ロールは要る操作だけに絞ってあるが、Cloud Control と
 * cloudfront:UpdateDistribution / CreateDistribution はリソースを絞れず `*` になっていて、
 * 他のアプリのディストリビューションにも届く。そこをアプリの単位で閉じるのがこのポリシーの役目。
 * 作りは sakekasu-kakeibo の同名ファイルに倣った。
 *
 * - 他のアプリの App タグが付いたリソースには触れない（読み取りも含めて拒否する）
 * - 他のアプリの App タグを付けない（このアプリの値以外のタグを付けて作る・付け替える）
 * - IAM ロールは App タグを付けていない（理由は bin/app.ts）ので、名前の接頭辞で絞る
 * - GitHub Actions のロール自身は書き換えない（接頭辞の範囲に入ってしまうため、別に止める）
 * - IAM ユーザー・アクセスキー・MFA・ID プロバイダー、Organizations、アカウント設定、
 *   CloudTrail（証跡と CloudTrail Lake）の停止や削除には触れない。どのアプリのデプロイにも要らない
 * - cdkd の状態バケットそのものと、他のアプリの状態を消したり書き換えたりしない。共用の資産置き場は消さない
 *
 * App タグを条件にした Deny は、aws:ResourceTag を評価しない API（S3 のオブジェクト操作など）
 * には効かない。状態バケットのオブジェクトは名前で別に止めている。
 */
export interface DeployGuardrailProps {
  /** デプロイ先のアカウント ID */
  account: string;
  /** このアプリの App タグの値 */
  app: string;
  /** このアプリが作る IAM ロールと管理ポリシーの名前の接頭辞（スタック名の接頭辞） */
  resourceNamePrefix: string;
  /** 書き換えさせない GitHub Actions のロールの名前 */
  protectedRoleNames: string[];
}

/**
 * 状態バケット（`cdkd/<スタック名>/<リージョン>/state.json`）にある他のアプリのスタック名。
 * アプリやスタックを足したらここにも足す。このアプリの分は呼び出し側の接頭辞で除く。
 * 末尾に `-` を付けないのは、接尾辞の無いスタック名（`ReinventPlanner` のような）も拾うため
 */
export const CDKD_STACK_NAME_PATTERNS: Record<string, string[]> = {
  builder: ['sakekasu-dev*', 'sakekasu-staging*', 'sakekasu-prod*'],
  integrated: ['sakekasu-integrated*'],
  kakeibo: ['sakekasu-kakeibo*'],
  learning: ['sakekasu-learning*'],
  reinvent: ['ReinventPlanner*'],
};

/** IAM ロールを作り替える操作。ロールにはタグが無いので、名前で範囲を絞る */
const ROLE_WRITE_ACTIONS = [
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:UpdateRole',
  'iam:UpdateRoleDescription',
  'iam:UpdateAssumeRolePolicy',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:PutRolePermissionsBoundary',
  'iam:DeleteRolePermissionsBoundary',
  'iam:TagRole',
  'iam:UntagRole',
  'iam:PassRole',
  'iam:CreatePolicy',
  'iam:CreatePolicyVersion',
  'iam:DeletePolicy',
  'iam:DeletePolicyVersion',
  'iam:SetDefaultPolicyVersion',
];

export function deployGuardrailStatements(props: DeployGuardrailProps): iam.PolicyStatement[] {
  const { account, app, resourceNamePrefix, protectedRoleNames } = props;
  const stateBucket = `arn:aws:s3:::cdkd-state-${account}`;
  const otherStacks = Object.entries(CDKD_STACK_NAME_PATTERNS)
    .filter(([name]) => name !== app)
    .flatMap(([, patterns]) => patterns);

  return [
    new iam.PolicyStatement({
      sid: 'DenyOtherAppsResources',
      effect: iam.Effect.DENY,
      actions: ['*'],
      resources: ['*'],
      conditions: {
        Null: { 'aws:ResourceTag/App': 'false' },
        StringNotEquals: { 'aws:ResourceTag/App': app },
      },
    }),
    new iam.PolicyStatement({
      sid: 'DenyForeignAppTag',
      effect: iam.Effect.DENY,
      actions: ['*'],
      resources: ['*'],
      conditions: {
        Null: { 'aws:RequestTag/App': 'false' },
        StringNotEquals: { 'aws:RequestTag/App': app },
      },
    }),
    new iam.PolicyStatement({
      sid: 'DenyRolesOutsideApp',
      effect: iam.Effect.DENY,
      actions: ROLE_WRITE_ACTIONS,
      notResources: [
        `arn:aws:iam::${account}:role/${resourceNamePrefix}*`,
        `arn:aws:iam::${account}:policy/${resourceNamePrefix}*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: 'DenyTamperingWithGithubActionsRoles',
      effect: iam.Effect.DENY,
      // 読み取り（Get / List）は通す
      actions: ['iam:Create*', 'iam:Delete*', 'iam:Update*', 'iam:Put*', 'iam:Attach*', 'iam:Detach*', 'iam:Tag*', 'iam:Untag*'],
      resources: protectedRoleNames.map((name) => `arn:aws:iam::${account}:role/${name}`),
    }),
    new iam.PolicyStatement({
      sid: 'DenyIdentityAndAccountControl',
      effect: iam.Effect.DENY,
      actions: [
        'iam:*User*',
        'iam:*AccessKey*',
        'iam:*LoginProfile*',
        'iam:*Group*',
        'iam:*OpenIDConnectProvider*',
        'iam:*SAMLProvider*',
        'iam:*ServiceSpecificCredential*',
        'iam:*SSHPublicKey*',
        'iam:*MFADevice*',
        'iam:*AccountPasswordPolicy',
        'iam:*AccountAlias',
        'organizations:*',
        'account:*',
        'sso:*',
        'sso-directory:*',
        'identitystore:*',
        'cloudtrail:DeleteTrail',
        'cloudtrail:StopLogging',
        'cloudtrail:UpdateTrail',
        'cloudtrail:PutEventSelectors',
        'cloudtrail:PutInsightSelectors',
        'cloudtrail:DeleteEventDataStore',
        'cloudtrail:UpdateEventDataStore',
        'cloudtrail:StopEventDataStoreIngestion',
        'cloudtrail:DeleteChannel',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'DenyChangingCdkdStateBucket',
      effect: iam.Effect.DENY,
      actions: [
        's3:DeleteBucket',
        's3:PutBucketPolicy',
        's3:DeleteBucketPolicy',
        's3:PutBucketAcl',
        's3:PutBucketVersioning',
        's3:PutLifecycleConfiguration',
        's3:PutBucketOwnershipControls',
        's3:PutBucketPublicAccessBlock',
        's3:PutEncryptionConfiguration',
        's3:PutBucketLogging',
        's3:PutReplicationConfiguration',
        's3:PutBucketNotification',
        's3:PutBucketObjectLockConfiguration',
      ],
      resources: [stateBucket],
    }),
    new iam.PolicyStatement({
      sid: 'DenyWritingOtherAppsState',
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: otherStacks.map((pattern) => `${stateBucket}/cdkd/${pattern}`),
    }),
    // cdkd の資産置き場（Lambda のコードなど）も全アプリで共用。キーは中身のハッシュだけで
    // アプリごとの接頭辞が無いので、名前でアプリを分けられない。cdkd は資産を消さない
    // （有無を確かめて無ければ置くだけ）ので、削除だけを全部止める。上書きは止められない
    new iam.PolicyStatement({
      sid: 'DenyDeletingCdkdAssets',
      effect: iam.Effect.DENY,
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:DeleteBucket'],
      // ARN の * は / もまたぐので、バケットとその中のオブジェクトの両方に当たる
      resources: [`arn:aws:s3:::cdkd-assets-${account}-*`],
    }),
  ];
}
