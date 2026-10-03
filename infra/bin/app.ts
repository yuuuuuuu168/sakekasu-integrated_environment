#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { parseApps } from '../lib/apps';
import { CdkdDeployStack } from '../lib/cdkd-deploy-stack';
import { CertStack } from '../lib/cert-stack';
import { DnsStack } from '../lib/dns-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { IdentityStack, type CustomAuthDomain } from '../lib/identity-stack';
import { AUTH_DOMAIN, PREFIX, REGION, REPOSITORY } from '../lib/names';

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
   *   1. authZone を書く        → ゾーンのスタックができる。NS を親に委任してもらう
   *   2. authHostedZoneId を書く → us-east-1 に証明書のスタックができる
   *   3. authCertificateArn を書く → ログイン画面がその独自ドメインに移る
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

  if (authHostedZoneId) {
    new CertStack(app, `${PREFIX}-auth-cert`, {
      domainName: AUTH_DOMAIN,
      hostedZoneId: authHostedZoneId,
      env: { account, region: 'us-east-1' },
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
}
