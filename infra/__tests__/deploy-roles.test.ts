import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkdDeployStack, DENIED_USER_ACTIONS } from '../lib/cdkd-deploy-stack';
import { BOUNDED_ROLE_WRITE_ACTIONS, PASS_ROLE_TARGET_SERVICES } from '../lib/cdkd-monitoring-statements';
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

const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/sakekasu-integrated-role-boundary`;

/** cdkd 用ロールに付いている管理ポリシーの文（同じスタックにある境界ポリシーは除く） */
function cdkdStatements(): Statement[] {
  const policies = cdkdTemplate().findResources('AWS::IAM::ManagedPolicy');
  return Object.values(policies)
    .filter((p) => p.Properties.ManagedPolicyName !== 'sakekasu-integrated-role-boundary')
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

function boundaryStatements(): Statement[] {
  const policies = cdkdTemplate().findResources('AWS::IAM::ManagedPolicy', {
    Properties: { ManagedPolicyName: 'sakekasu-integrated-role-boundary' },
  });
  const [boundary] = Object.values(policies);
  expect(boundary, '境界ポリシーが無い').toBeDefined();
  return boundary.Properties.PolicyDocument.Statement as Statement[];
}

const allows = () => cdkdStatements().filter((s) => s.Effect === 'Allow');
const denies = () => cdkdStatements().filter((s) => s.Effect === 'Deny');

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

  it('ロールに付く管理ポリシーは 3 つ（既存の分、監視の分、ロールの分）で、境界は付けない', () => {
    const role = Object.values(cdkdTemplate().findResources('AWS::IAM::Role'))[0];
    expect(role.Properties.ManagedPolicyArns).toHaveLength(3);
    expect(role.Properties.PermissionsBoundary).toBeUndefined();
  });

  // 上限を超えるとデプロイ（CloudFormation）が失敗し、cdkd 用ロールが更新されない
  it('管理ポリシーはどれも IAM の上限（空白を除いて 6,144 文字）に収まる', () => {
    for (const p of Object.values(cdkdTemplate().findResources('AWS::IAM::ManagedPolicy'))) {
      const size = JSON.stringify(p.Properties.PolicyDocument).replace(/\s/g, '').length;
      expect(size, p.Properties.ManagedPolicyName).toBeLessThan(6144 - 300);
    }
  });

  describe('IAM（監視のロールだけ、境界付きで）', () => {
    const iamAllows = () => allows().filter((s) => asArray(s.Action).some((a) => a.startsWith('iam:')));

    it('IAM を許すのは sakekasu-integrated-app-* のロールだけ（デプロイ用ロールは範囲に入らない）', () => {
      const statements = iamAllows();
      expect(statements.length).toBeGreaterThan(0);
      for (const s of statements) {
        expect(asArray(s.Resource), s.Sid).toEqual([`arn:aws:iam::${ACCOUNT}:role/sakekasu-integrated-app-*`]);
      }
    });

    it('権限を書き換える操作は、境界が付いているときだけ許す', () => {
      const writes = iamAllows().filter((s) => asArray(s.Action).some((a) => BOUNDED_ROLE_WRITE_ACTIONS.includes(a)));
      expect(writes).toHaveLength(1);
      expect(asArray(writes[0].Action).sort()).toEqual([...BOUNDED_ROLE_WRITE_ACTIONS].sort());
      expect(writes[0].Condition).toEqual({ ArnEquals: { 'iam:PermissionsBoundary': BOUNDARY_ARN } });
    });

    it('境界の無いロールの作成・書き換えは Deny する', () => {
      const deny = denies().find((s) => s.Sid === 'DenyRoleWritesWithoutBoundary');
      expect(deny).toBeDefined();
      expect(asArray(deny!.Action)).toEqual(expect.arrayContaining(['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy']));
      expect(deny!.Resource).toBe('*');
      expect(deny!.Condition).toEqual({ ArnNotEquals: { 'iam:PermissionsBoundary': BOUNDARY_ARN } });
    });

    it('境界の取り外しと、境界ポリシーの書き換え・削除は Deny する', () => {
      const removing = denies().find((s) => asArray(s.Action).includes('iam:DeleteRolePermissionsBoundary'));
      expect(removing?.Resource).toBe('*');
      const rewriting = denies().find((s) => asArray(s.Action).includes('iam:CreatePolicyVersion'));
      expect(asArray(rewriting!.Action)).toEqual(
        expect.arrayContaining(['iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:DeletePolicy']),
      );
      expect(rewriting!.Resource).toBe(BOUNDARY_ARN);
    });

    it('デプロイ用ロール自身には一切触れない', () => {
      const deny = denies().find((s) => s.Sid === 'DenyTamperingWithDeployRoles');
      expect(deny!.Action).toBe('iam:*');
      expect(asArray(deny!.Resource)).toEqual([
        `arn:aws:iam::${ACCOUNT}:role/sakekasu-integrated-github-actions-deploy`,
        `arn:aws:iam::${ACCOUNT}:role/sakekasu-integrated-github-actions-cdkd`,
      ]);
    });

    it('PassRole は Lambda と EventBridge にだけ渡せる', () => {
      const pass = iamAllows().filter((s) => asArray(s.Action).includes('iam:PassRole'));
      expect(pass).toHaveLength(1);
      expect(asArray(pass[0].Action)).toEqual(['iam:PassRole']);
      expect(pass[0].Condition).toEqual({ StringEquals: { 'iam:PassedToService': PASS_ROLE_TARGET_SERVICES } });
      expect(PASS_ROLE_TARGET_SERVICES).toEqual(['lambda.amazonaws.com', 'events.amazonaws.com']);
    });

    // 信頼ポリシーを書き換えられると、外のアカウントからロールの権限を使える
    it('信頼ポリシーの書き換え（UpdateAssumeRolePolicy）と、ユーザー・ポリシーの作成は許さない', () => {
      const actions = iamAllows().flatMap((s) => asArray(s.Action));
      expect(actions).not.toContain('iam:UpdateAssumeRolePolicy');
      expect(actions.filter((a) => /User|Group|CreatePolicy|AccessKey/.test(a))).toEqual([]);
    });
  });

  describe('境界ポリシー', () => {
    it('監視の Lambda と転送に要る操作だけを並べ、IAM と STS は拒否する', () => {
      const statements = boundaryStatements();
      const allowed = statements.filter((s) => s.Effect === 'Allow').flatMap((s) => asArray(s.Action));
      expect(allowed.sort()).toEqual(
        [
          'cloudwatch:PutMetricData',
          'events:PutEvents',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'sns:Publish',
          'ssm:GetParameter',
          'xray:PutTelemetryRecords',
          'xray:PutTraceSegments',
        ].sort(),
      );
      const denied = statements.filter((s) => s.Effect === 'Deny').flatMap((s) => asArray(s.Action));
      expect(denied).toEqual(expect.arrayContaining(['iam:*', 'sts:*']));
    });

    it('SSM はこのリポジトリのパラメータだけ読める', () => {
      const ssm = boundaryStatements().find((s) => asArray(s.Action).includes('ssm:GetParameter'));
      expect(JSON.stringify(ssm!.Resource)).toContain(':parameter/sakekasu-integrated/*');
    });
  });

  describe('監視のスタックの分', () => {
    it.each([
      ['lambda:CreateFunction', `function:sakekasu-integrated-*`],
      ['sns:CreateTopic', `:sakekasu-integrated-*`],
      ['events:PutRule', `rule/sakekasu-integrated-*`],
      ['cloudwatch:PutMetricAlarm', `alarm:sakekasu-integrated-*`],
      ['logs:CreateLogGroup', `log-group:/aws/lambda/sakekasu-integrated-*`],
    ])('%s は名前が sakekasu-integrated- で始まるものだけ', (action, resource) => {
      const statements = allows().filter((s) => asArray(s.Action).includes(action));
      expect(statements).toHaveLength(1);
      for (const r of asArray(statements[0].Resource)) expect(r).toContain(resource);
    });

    // デプロイには要らない。トピックへの publish は各アプリのアラームと EventBridge の仕事
    it('トピックへの publish や、ログの中身の読み取りは許さない', () => {
      const actions = allows().flatMap((s) => asArray(s.Action));
      expect(actions).not.toContain('sns:Publish');
      expect(actions.filter((a) => /^logs:(Get|Filter|StartQuery)/.test(a) && a !== 'logs:GetDataProtectionPolicy')).toEqual([]);
    });

    it('Lambda のコードは cdkd のアセットの置き場所（両リージョン）にだけ上げられる', () => {
      const put = allows().filter((s) => asArray(s.Action).includes('s3:PutObject'));
      const assetWrites = put.filter((s) => JSON.stringify(s.Resource).includes('cdkd-assets-'));
      expect(assetWrites).toHaveLength(1);
      expect(asArray(assetWrites[0].Resource)).toEqual([
        `arn:aws:s3:::cdkd-assets-${ACCOUNT}-ap-northeast-1/*`,
        `arn:aws:s3:::cdkd-assets-${ACCOUNT}-us-east-1/*`,
      ]);
      // CDK の bootstrap バケットには書かない
      expect(JSON.stringify(put)).not.toContain('cdk-hnb659fds');
    });
  });

  it('Cognito のユーザーそのものの操作は拒否する', () => {
    const deny = cdkdStatements().find((s) => s.Sid === 'DenyCognitoUserData');
    expect(deny?.Effect).toBe('Deny');
    expect(asArray(deny!.Action)).toEqual(DENIED_USER_ACTIONS);
    expect(DENIED_USER_ACTIONS).toContain('cognito-idp:Admin*');
  });

  it('共用の状態バケットには、このリポジトリのスタックの分だけ書ける', () => {
    const write = cdkdStatements().filter((s) =>
      s.Effect === 'Allow' &&
      JSON.stringify(s.Resource).includes('cdkd-state-') &&
      asArray(s.Action).some((a) => a === 's3:PutObject' || a === 's3:DeleteObject'),
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
