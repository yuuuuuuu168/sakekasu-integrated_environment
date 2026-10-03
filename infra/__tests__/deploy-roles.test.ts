import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkdDeployStack, DENIED_USER_ACTIONS } from '../lib/cdkd-deploy-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const ACCOUNT = '123456789012';
const REPOSITORY = 'yuuuuuuu168/sakekasu-integrated_environment';
const env = { account: ACCOUNT, region: 'ap-northeast-1' };

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
}

const asArray = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

function cdkdTemplate() {
  return Template.fromStack(new CdkdDeployStack(new cdk.App(), 'test-cdkd', { repository: REPOSITORY, env }));
}

function cdkdStatements(): Statement[] {
  const policies = cdkdTemplate().findResources('AWS::IAM::ManagedPolicy');
  return Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

function trustSubjects(template: Template): string[] {
  const role = Object.values(template.findResources('AWS::IAM::Role'))[0];
  return role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike[
    'token.actions.githubusercontent.com:sub'
  ];
}

describe('両ロール共通', () => {
  it.each([
    ['github-oidc', () => Template.fromStack(new GithubOidcStack(new cdk.App(), 'o', { repository: REPOSITORY, env }))],
    ['cdkd-deploy', cdkdTemplate],
  ])('%s: このリポジトリの main だけを信頼し、OIDC プロバイダーは作らない', (_, make) => {
    const t = make();
    expect(trustSubjects(t)).toEqual([
      'repo:yuuuuuuu168@*/sakekasu-integrated_environment@*:ref:refs/heads/main',
      'repo:yuuuuuuu168/sakekasu-integrated_environment:ref:refs/heads/main',
    ]);
    expect(Object.keys(t.findResources('AWS::IAM::OIDCProvider'))).toHaveLength(0);
  });
});

describe('cdkd 用ロール（権限を絞る）', () => {
  it('AWS 管理の広いポリシーを付けない', () => {
    const role = Object.values(cdkdTemplate().findResources('AWS::IAM::Role'))[0];
    const arns = JSON.stringify(role.Properties.ManagedPolicyArns ?? []);
    expect(arns).not.toMatch(/AdministratorAccess|PowerUserAccess|IAMFullAccess/);
  });

  it('許可にワイルドカードの操作（* や service:*）を含めない', () => {
    for (const s of cdkdStatements().filter((s) => s.Effect === 'Allow')) {
      for (const action of asArray(s.Action)) {
        expect(action, `${s.Sid}: ${action}`).not.toMatch(/(^\*$|:\*$)/);
      }
    }
  });

  it('IAM の操作を 1 つも許さない（ここから権限を広げられない）', () => {
    for (const s of cdkdStatements().filter((s) => s.Effect === 'Allow')) {
      for (const action of asArray(s.Action)) {
        expect(action, `${s.Sid}: ${action}`).not.toMatch(/^iam:/);
      }
    }
  });

  it('Cognito のユーザーそのものの操作は拒否する', () => {
    const deny = cdkdStatements().find((s) => s.Sid === 'DenyCognitoUserData');
    expect(deny?.Effect).toBe('Deny');
    expect(asArray(deny!.Action)).toEqual(DENIED_USER_ACTIONS);
    expect(DENIED_USER_ACTIONS).toContain('cognito-idp:Admin*');
  });

  it('共用の状態バケットには、このリポジトリのスタックの分だけ書ける', () => {
    const write = cdkdStatements().filter((s) =>
      s.Effect === 'Allow' && asArray(s.Action).some((a) => a === 's3:PutObject' || a === 's3:DeleteObject'),
    );
    expect(write).toHaveLength(1);
    expect(JSON.stringify(write[0].Resource)).toContain('/cdkd/sakekasu-integrated-*');
  });

  it('Route53 のレコードは auth.sakekasu-builder.com の配下だけ書ける', () => {
    const records = cdkdStatements().filter((s) => asArray(s.Action).includes('route53:ChangeResourceRecordSets'));
    expect(records).toHaveLength(1);
    expect(records[0].Condition).toEqual({
      'ForAllValues:StringLike': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['auth.sakekasu-builder.com', '*.auth.sakekasu-builder.com'],
      },
    });
  });

  it('Cloud Control は使えるが、CloudFormation のスタック操作は許さない', () => {
    const actions = cdkdStatements()
      .filter((s) => s.Effect === 'Allow')
      .flatMap((s) => asArray(s.Action))
      .filter((a) => a.startsWith('cloudformation:'));
    expect(actions).toContain('cloudformation:CreateResource');
    expect(actions.filter((a) => /Stack|ChangeSet/.test(a))).toEqual([]);
  });

  it('状態のバージョン操作も、このリポジトリのスタックの分だけ', () => {
    const versionDelete = cdkdStatements().filter((s) => asArray(s.Action).includes('s3:DeleteObjectVersion'));
    expect(versionDelete).toHaveLength(1);
    expect(JSON.stringify(versionDelete[0].Resource)).toContain('/cdkd/sakekasu-integrated-*');
  });
});
