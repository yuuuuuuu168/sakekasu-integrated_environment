#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { parseApps } from '../lib/apps';
import { CertStack } from '../lib/cert-stack';
import { DnsStack } from '../lib/dns-stack';
import { IdentityStack, type CustomAuthDomain } from '../lib/identity-stack';
import { AUTH_DOMAIN, PREFIX, REGION } from '../lib/names';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

function context(key: string): string | undefined {
  const value = app.node.tryGetContext(key) as unknown;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

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
