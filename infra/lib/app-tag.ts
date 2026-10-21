import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** このリポジトリの App タグの値（docs/aws-infra-rules.md の 2 節） */
export const APP_TAG_VALUE = 'integrated';

/**
 * 全リソースに App タグを付ける。アプリごとのコストを Cost Explorer で分けるため。
 * デプロイ用ロールのガードレール（deploy-guardrail.ts）の「他のアプリのタグが付いたリソースには
 * 触れない」判定にもこのタグを使う。4 アプリと共通基盤が同じアカウントに
 * 同居していて、名前の接頭辞では分けきれないためタグで見分ける。
 *
 * IAM ロールには付けない（docs/aws-infra-rules.md の 2 節）。ロールのプロパティを変えると、
 * 実物の名前が cdkd の導く名前と違うときに作り直しになる。ロールはタグではなく名前で範囲を絞っている
 *
 * ただし外せるのは cdkd で入れるスタック（monitoring、health-global）のロールだけ。CDK はこのタグを
 * スタック自体のタグとしても CloudFormation に渡し、CloudFormation はスタックのタグを中の全リソースに
 * 付ける。excludeResourceTypes はテンプレートの中にしか効かないので、CloudFormation で入れるスタック
 * （cdkd-deploy、github-oidc）のロールには App タグが付く（2026-10-20 のデプロイで確かめた）。
 * CloudFormation ではタグの変更でロールは作り直されないので、そのままにしている
 */
export function applyAppTag(scope: IConstruct): void {
  cdk.Tags.of(scope).add('App', APP_TAG_VALUE, { excludeResourceTypes: ['AWS::IAM::Role'] });
}
