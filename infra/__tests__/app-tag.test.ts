import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { applyAppTag } from '../lib/app-tag';

type Tags = { Key: string; Value: string }[] | undefined;

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'test-tags', { env: { account: '123456789012', region: 'ap-northeast-1' } });
  new iam.Role(stack, 'Role', { roleName: 'test-role', assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  new sns.Topic(stack, 'Topic');
  applyAppTag(app);
  return Template.fromStack(stack);
}

describe('App タグ', () => {
  const template = synth();
  const tagsOf = (type: string): Tags => Object.values(template.findResources(type))[0].Properties.Tags as Tags;

  it('IAM ロール以外には付ける', () => {
    expect(tagsOf('AWS::SNS::Topic')).toContainEqual({ Key: 'App', Value: 'integrated' });
  });

  // ロールのプロパティを変えると、実物の名前が cdkd の導く名前と違うときに作り直しになる
  // （docs/aws-infra-rules.md の 2 節と 7 節）
  it('IAM ロールには付けない', () => {
    expect((tagsOf('AWS::IAM::Role') ?? []).map((t) => t.Key)).not.toContain('App');
  });
});
