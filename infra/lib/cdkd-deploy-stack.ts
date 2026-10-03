import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { githubMainBranchPrincipal } from './github-principal';
import { AUTH_DOMAIN, CDKD_DEPLOY_ROLE_NAME, PREFIX } from './names';

export interface CdkdDeployStackProps extends cdk.StackProps {
  /** 信頼する GitHub リポジトリ（owner/repo 形式） */
  repository: string;
}

/** cdkd が触ってよいリージョン。Cognito などは東京、証明書と Route53・CloudFront は us-east-1 */
export const ALLOWED_REGIONS = ['ap-northeast-1', 'us-east-1'];

/**
 * Cognito のうち、ユーザーそのものを読み書きする操作。cdkd は使わないので明示的に拒否する。
 * デプロイの経路から、ユーザーの作成・パスワードの変更・なりすましのログインができないようにする。
 */
export const DENIED_USER_ACTIONS = [
  'cognito-idp:Admin*',
  'cognito-idp:ListUsers',
  'cognito-idp:ListUsersInGroup',
  'cognito-idp:SignUp',
  'cognito-idp:InitiateAuth',
  'cognito-idp:RespondToAuthChallenge',
];

/**
 * 共通基盤のスタックを cdkd でデプロイするためのロール。
 *
 * cdkd は CloudFormation を通さず、各サービスの API を呼び出し元の権限で直接叩く。
 * sakekasu-kakeibo では AdministratorAccess を付けているが、こちらは利用者の方針で
 * いま置いているスタック（ゾーン、証明書、ユーザープール）に要る操作だけを許す。
 * 足りなければデプロイの途中で AccessDenied で落ちるので、そのたびに足す。
 * 監視のスタック（Lambda、SNS、EventBridge、CloudWatch）を足すときに、その分も足す。
 *
 * - IAM の操作は 1 つも持たない（ロールを作れないので、ここから権限を広げられない）
 * - Cognito はユーザープールの設定だけ。ユーザーそのものの操作は拒否する
 * - Route53 のレコードは auth.sakekasu-builder.com の配下だけ書ける
 * - cdkd の状態バケットは他のアプリと共用なので、このリポジトリのスタックの分だけ書ける
 *
 * このスタック自身は CloudFormation（`cdk deploy`）で入れる。cdkd に自分の権限の出どころを
 * 管理させると、壊したときに直す手段が無くなるため。deploy ワークフローが毎回入れる。
 */
export class CdkdDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CdkdDeployStackProps) {
    super(scope, id, props);

    const account = this.account;
    const partition = this.partition;
    const regionCondition = { StringEquals: { 'aws:RequestedRegion': ALLOWED_REGIONS } };

    const policy = new iam.ManagedPolicy(this, 'CdkdDeployPolicy', {
      managedPolicyName: `${PREFIX}-cdkd-deploy`,
      // IAM の description は ASCII + Latin-1 のみ
      description: 'Least-privilege permissions for cdkd deploy of sakekasu-integrated stacks',
      statements: [
        new iam.PolicyStatement({
          sid: 'Identity',
          actions: ['sts:GetCallerIdentity'],
          resources: ['*'],
        }),

        // cdkd の状態。バケットは kakeibo・learning と共用なので、書けるのはこのリポジトリの分だけ
        new iam.PolicyStatement({
          sid: 'CdkdStateList',
          // ListBucketVersions は、失敗時のロールバック記録の古い版を消すときに cdkd が使う
          actions: ['s3:ListBucket', 's3:ListBucketVersions', 's3:GetBucketLocation', 's3:GetBucketVersioning'],
          resources: [`arn:${partition}:s3:::cdkd-state-${account}`],
        }),
        new iam.PolicyStatement({
          sid: 'CdkdStateReadWrite',
          actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
          resources: [`arn:${partition}:s3:::cdkd-state-${account}/cdkd/${PREFIX}-*`],
        }),
        // スタック間の出力の索引と、bootstrap 済みかの印。cdkd が読む
        new iam.PolicyStatement({
          sid: 'CdkdSharedRead',
          actions: ['s3:GetObject'],
          resources: [
            `arn:${partition}:s3:::cdkd-state-${account}/cdkd/_index/*`,
            `arn:${partition}:s3:::cdkd-state-${account}/cdkd-bootstrap/*`,
          ],
        }),

        /*
         * Cloud Control API。cdkd は専用の実装が無いリソース（ユーザープールのドメイン・クライアント・
         * ブランディングなど）をこれで作る。Cloud Control は呼び出し元の権限でそのまま各サービスを
         * 呼ぶので、ここを許しても、下の Cognito などで許した以上のことはできない。
         * 初回のデプロイで cloudformation:CreateResource が AccessDenied になって分かった。
         */
        new iam.PolicyStatement({
          sid: 'CloudControl',
          actions: [
            'cloudformation:CreateResource',
            'cloudformation:GetResource',
            'cloudformation:UpdateResource',
            'cloudformation:DeleteResource',
            'cloudformation:ListResources',
            'cloudformation:GetResourceRequestStatus',
            'cloudformation:CancelResourceRequest',
          ],
          resources: ['*'],
          conditions: regionCondition,
        }),
        // リソースの型の定義（作り直しが要る変更かどうかの判定に cdkd が読む）。読み取りだけ
        new iam.PolicyStatement({
          sid: 'ResourceTypeSchema',
          actions: ['cloudformation:DescribeType'],
          resources: [`arn:${partition}:cloudformation:*::type/resource/*`],
          conditions: regionCondition,
        }),

        // Cognito: ユーザープールとその設定
        new iam.PolicyStatement({
          sid: 'CognitoUserPoolCreate',
          actions: ['cognito-idp:CreateUserPool', 'cognito-idp:ListUserPools', 'cognito-idp:DescribeUserPoolDomain'],
          resources: ['*'],
          conditions: regionCondition,
        }),
        new iam.PolicyStatement({
          sid: 'CognitoUserPoolManage',
          actions: [
            'cognito-idp:DescribeUserPool',
            'cognito-idp:UpdateUserPool',
            'cognito-idp:DeleteUserPool',
            'cognito-idp:GetUserPoolMfaConfig',
            'cognito-idp:SetUserPoolMfaConfig',
            'cognito-idp:CreateUserPoolClient',
            'cognito-idp:DescribeUserPoolClient',
            'cognito-idp:UpdateUserPoolClient',
            'cognito-idp:DeleteUserPoolClient',
            'cognito-idp:ListUserPoolClients',
            'cognito-idp:CreateUserPoolDomain',
            'cognito-idp:UpdateUserPoolDomain',
            'cognito-idp:DeleteUserPoolDomain',
            'cognito-idp:CreateManagedLoginBranding',
            'cognito-idp:DescribeManagedLoginBranding',
            'cognito-idp:DescribeManagedLoginBrandingByClient',
            'cognito-idp:UpdateManagedLoginBranding',
            'cognito-idp:DeleteManagedLoginBranding',
            'cognito-idp:TagResource',
            'cognito-idp:UntagResource',
            'cognito-idp:ListTagsForResource',
          ],
          resources: [`arn:${partition}:cognito-idp:*:${account}:userpool/*`],
          conditions: regionCondition,
        }),
        new iam.PolicyStatement({
          sid: 'DenyCognitoUserData',
          effect: iam.Effect.DENY,
          actions: DENIED_USER_ACTIONS,
          resources: ['*'],
        }),

        // Cognito の独自ドメインは裏で CloudFront を使い、作る人に証明書の参照と配信の更新を求める
        new iam.PolicyStatement({
          sid: 'CognitoCustomDomain',
          actions: ['cloudfront:UpdateDistribution'],
          resources: ['*'],
          conditions: regionCondition,
        }),

        // 証明書（us-east-1）
        new iam.PolicyStatement({
          sid: 'CertificateCreate',
          actions: ['acm:RequestCertificate', 'acm:ListCertificates'],
          resources: ['*'],
          conditions: regionCondition,
        }),
        new iam.PolicyStatement({
          sid: 'CertificateManage',
          actions: [
            'acm:DescribeCertificate',
            'acm:DeleteCertificate',
            'acm:AddTagsToCertificate',
            'acm:RemoveTagsFromCertificate',
            'acm:ListTagsForCertificate',
          ],
          resources: [`arn:${partition}:acm:*:${account}:certificate/*`],
          conditions: regionCondition,
        }),

        // Route53: ゾーンの作成と、auth.sakekasu-builder.com 配下のレコードだけ
        new iam.PolicyStatement({
          sid: 'HostedZoneCreate',
          actions: ['route53:CreateHostedZone', 'route53:ListHostedZones', 'route53:ListHostedZonesByName', 'route53:GetChange'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'HostedZoneRead',
          actions: [
            'route53:GetHostedZone',
            'route53:ListResourceRecordSets',
            'route53:ListTagsForResource',
            'route53:ChangeTagsForResource',
            'route53:UpdateHostedZoneComment',
          ],
          resources: [`arn:${partition}:route53:::hostedzone/*`],
        }),
        new iam.PolicyStatement({
          sid: 'AuthRecords',
          actions: ['route53:ChangeResourceRecordSets'],
          resources: [`arn:${partition}:route53:::hostedzone/*`],
          conditions: {
            'ForAllValues:StringLike': {
              'route53:ChangeResourceRecordSetsNormalizedRecordNames': [AUTH_DOMAIN, `*.${AUTH_DOMAIN}`],
            },
          },
        }),
      ],
    });

    const role = new iam.Role(this, 'CdkdDeployRole', {
      roleName: CDKD_DEPLOY_ROLE_NAME,
      // IAM の description は ASCII + Latin-1 のみ。日本語を入れるとデプロイが 400 で落ちる
      description: 'cdkd deploy from GitHub Actions (main branch only, least privilege)',
      assumedBy: githubMainBranchPrincipal(this, props.repository),
      managedPolicies: [policy],
    });

    new cdk.CfnOutput(this, 'CdkdDeployRoleArn', { value: role.roleArn });
  }
}
