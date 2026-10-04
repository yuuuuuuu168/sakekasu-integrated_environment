#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApexRedirectStack } from '../lib/apex-redirect-stack';
import { parseApps } from '../lib/apps';
import { CdkdDeployStack } from '../lib/cdkd-deploy-stack';
import { DnsStack } from '../lib/dns-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { HealthGlobalStack } from '../lib/health-global-stack';
import { parseHealthChecks } from '../lib/health-checks';
import { IdentityStack, type CustomAuthDomain } from '../lib/identity-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import {
  APEX_DOMAINS,
  APEX_REDIRECT_REGION,
  APEX_REDIRECT_STACK_NAME,
  APEX_REDIRECT_TARGET,
  AUTH_DOMAIN,
  GLOBAL_HEALTH_REGION,
  HEALTH_GLOBAL_STACK_NAME,
  MONITORING_STACK_NAME,
  PREFIX,
  REGION,
  REPOSITORY,
} from '../lib/names';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

function context(key: string): string | undefined {
  const value = app.node.tryGetContext(key) as unknown;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/*
 * GitHub Actions のロールは、基盤のスタックと同じ実行に混ぜない。混ぜると
 * `cdkd deploy --all` でロールまで巻き込める。フラグを付けたときは、そのスタックだけを合成する。
 *
 * - github-oidc: 最初に引き受けるロール。Mac から一度だけ手で入れる
 *     npx cdk deploy sakekasu-integrated-github-oidc -c github-oidc=true
 * - cdkd-deploy: cdkd が使う権限を絞ったロール。deploy ワークフローが毎回 CloudFormation で入れる
 */
if (app.node.tryGetContext('github-oidc')) {
  new GithubOidcStack(app, `${PREFIX}-github-oidc`, { repository: REPOSITORY, env: { account, region: REGION } });
} else if (app.node.tryGetContext('cdkd-deploy')) {
  new CdkdDeployStack(app, `${PREFIX}-cdkd-deploy`, { repository: REPOSITORY, env: { account, region: REGION } });
} else {
  buildPlatformStacks();
}

/** 共通基盤のスタック */
function buildPlatformStacks(): void {
  /*
   * 共通ログイン画面の独自ドメインは、3 段階で有効にする（docs/identity.md）。
   *
   *   1. authZone を書く → ゾーンのスタックができる。NS を親に委任してもらう
   *   2. authHostedZoneId を書き、us-east-1 に証明書をコンソールで作る（cdkd では作らない）
   *   3. authCertificateArn を書く → ログイン画面がその独自ドメインに移る
   *
   * 証明書を cdkd で作らないのは、cdkd が ACM の DNS 検証レコードを書かず、CDK が付ける
   * 検証設定（DomainValidationOptions）も ACM に渡せないため（2026-10-03 のデプロイで
   * ValidationDomain が null だと弾かれた）。コンソールなら「Route 53 でレコードを作成」で
   * 同じアカウントのこのゾーンに検証レコードが入る。証明書は一度作れば ACM が自動で更新する。
   *
   * それまでは Cognito のドメイン（cognitoDomainPrefix）でログイン画面を出す。
   * スタックの間は参照でつながず、ID や ARN は context で渡す。
   */
  const authZone = context('authZone');
  const authHostedZoneId = context('authHostedZoneId');
  const authCertificateArn = context('authCertificateArn');

  if (authZone) {
    new DnsStack(app, `${PREFIX}-auth-dns`, {
      zoneName: authZone,
      env: { account, region: REGION },
    });
  }

  const customDomain: CustomAuthDomain | undefined =
    authHostedZoneId && authCertificateArn
      ? { domainName: AUTH_DOMAIN, hostedZoneId: authHostedZoneId, certificateArn: authCertificateArn }
      : undefined;

  new IdentityStack(app, `${PREFIX}-identity`, {
    apps: parseApps(app.node.tryGetContext('apps')),
    cognitoDomainPrefix: context('cognitoDomainPrefix') ?? PREFIX,
    customDomain,
    env: { account, region: REGION },
  });

  /*
   * 4 アプリ共通の監視と Slack 通知（docs/monitoring.md）。
   * 外形監視の対象は context `healthChecks` に書く。グローバルの AWS Health は us-east-1 にしか
   * 来ないので、別スタックで監視リージョンへ転送する。こちらも参照でつながず、
   * 転送先のバスの ARN はアカウントとリージョンから組み立てる。
   */
  new MonitoringStack(app, MONITORING_STACK_NAME, {
    healthChecks: parseHealthChecks(app.node.tryGetContext('healthChecks')),
    env: { account, region: REGION },
  });
  new HealthGlobalStack(app, HEALTH_GLOBAL_STACK_NAME, {
    targetRegion: REGION,
    env: { account, region: GLOBAL_HEALTH_REGION },
  });

  /*
   * apex と www を builder の画面（sake.）へ転送する（docs/apex-redirect.md）。
   *
   * 証明書の ARN（apexCertificateArn）が入るまでは、CloudFront の既定のドメインだけで作る。
   * apex と www は Amplify の CloudFront に付いたままで、同じドメインは 2 つの CloudFront に
   * 同時に付けられない。Amplify から外してから ARN を入れ、こちらに付け替える。
   * 証明書は auth と同じくコンソールで作る（cdkd では作れない）。
   */
  const apexCertificateArn = context('apexCertificateArn');
  new ApexRedirectStack(app, APEX_REDIRECT_STACK_NAME, {
    targetDomain: APEX_REDIRECT_TARGET,
    ...(apexCertificateArn
      ? { customDomain: { domainNames: APEX_DOMAINS, certificateArn: apexCertificateArn } }
      : {}),
    env: { account, region: APEX_REDIRECT_REGION },
  });
}
