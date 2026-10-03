import { beforeAll, describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import { CdkdDeployStack } from '../lib/cdkd-deploy-stack';
import { HealthGlobalStack } from '../lib/health-global-stack';
import { parseHealthChecks } from '../lib/health-checks';
import { METRIC_NAMESPACE, MonitoringStack } from '../lib/monitoring-stack';

const ACCOUNT = '123456789012';
const env = { account: ACCOUNT, region: 'ap-northeast-1' };
const TOPIC_ARN_REF = { Ref: 'AlertTopic2720D535' };

/** cdk.json に書いてある対象をそのまま使う（実際に合成されるものを確かめる） */
const healthChecks = parseHealthChecks(
  JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')).context.healthChecks,
);

type Resource = { Properties: Record<string, any> };

let template: Template;
let globalTemplate: Template;

beforeAll(() => {
  const app = new cdk.App();
  const monitoring = new MonitoringStack(app, 'sakekasu-integrated-monitoring', { healthChecks, env });
  const global = new HealthGlobalStack(app, 'sakekasu-integrated-health-global', {
    targetRegion: 'ap-northeast-1',
    env: { account: ACCOUNT, region: 'us-east-1' },
  });
  template = Template.fromStack(monitoring);
  globalTemplate = Template.fromStack(global);
});

function alarms(): Resource[] {
  return Object.values(template.findResources('AWS::CloudWatch::Alarm')) as Resource[];
}

function alarm(name: string): Resource {
  const found = alarms().find((a) => a.Properties.AlarmName === name);
  expect(found, `アラーム ${name} が無い`).toBeDefined();
  return found!;
}

function topicPolicyStatements(): Array<Record<string, any>> {
  const policies = Object.values(template.findResources('AWS::SNS::TopicPolicy')) as Resource[];
  expect(policies).toHaveLength(1);
  return policies[0].Properties.PolicyDocument.Statement;
}

describe('通知の経路', () => {
  it('固定名のトピック sakekasu-integrated-alerts がある', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'sakekasu-integrated-alerts' });
  });

  it('トピックの ARN と名前を出力する', () => {
    template.hasOutput('AlertTopicArn', { Value: TOPIC_ARN_REF });
    template.hasOutput('AlertTopicName', { Value: { 'Fn::GetAtt': ['AlertTopic2720D535', 'TopicName'] } });
  });

  // 明示的なトピックポリシーを置くと既定（所有アカウントの publish）が消える。
  // builder ではこれでアラームが 9 日間無音になった
  it('CloudWatch アラームからの publish を、同じアカウントに限って明示的に許す', () => {
    const statement = topicPolicyStatements().find((s) => s.Principal?.Service === 'cloudwatch.amazonaws.com');
    expect(statement).toMatchObject({
      Effect: 'Allow',
      Action: 'sns:Publish',
      Resource: TOPIC_ARN_REF,
      Condition: {
        StringEquals: { 'aws:SourceAccount': ACCOUNT },
        ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:*:${ACCOUNT}:alarm:*` },
      },
    });
  });

  it('EventBridge からの publish も、同じアカウントのルールに限って許す', () => {
    const statements = topicPolicyStatements().filter((s) => s.Principal?.Service === 'events.amazonaws.com');
    // CDK の SnsTopic ターゲットが足す無条件の文が混ざっていない
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      Effect: 'Allow',
      Action: 'sns:Publish',
      Condition: {
        StringEquals: { 'aws:SourceAccount': ACCOUNT },
        ArnLike: { 'aws:SourceArn': `arn:aws:events:*:${ACCOUNT}:rule/*` },
      },
    });
  });

  it('トピックポリシーの許可はすべて条件付き（どこからでも publish できる文が無い）', () => {
    for (const s of topicPolicyStatements()) {
      expect(s.Condition, JSON.stringify(s)).toBeDefined();
      expect(s.Principal).not.toBe('*');
      expect(s.Principal?.AWS).toBeUndefined();
    }
  });

  it('Slack 通知 Lambda がトピックを購読している', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
      TopicArn: TOPIC_ARN_REF,
      Endpoint: { 'Fn::GetAtt': [Match.stringLikeRegexp('^SlackNotifierFunction'), 'Arn'] },
    });
  });

  it('Webhook URL はコードに持たず、SSM のパラメータ名だけを渡す', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'sakekasu-integrated-slack-notifier',
      Environment: { Variables: { WEBHOOK_PARAMETER_NAME: '/sakekasu-integrated/monitoring/slack-webhook-url' } },
    });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/hooks\.slack\.com/);
  });

  it('Slack 通知 Lambda の SSM の読み取りは、そのパラメータ 1 つだけ', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as Resource[];
    const ssm = policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, any>>)
      .filter((s) => JSON.stringify(s.Action).includes('ssm:'));
    expect(ssm).toHaveLength(1);
    expect(ssm[0].Action).toBe('ssm:GetParameter');
    expect(ssm[0].Resource).toBe(
      `arn:aws:ssm:ap-northeast-1:${ACCOUNT}:parameter/sakekasu-integrated/monitoring/slack-webhook-url`,
    );
  });

  it('Slack 通知の失敗そのものを監視する', () => {
    const a = alarm('sakekasu-integrated-slack-notifier-failure');
    expect(a.Properties).toMatchObject({ MetricName: 'Errors', Namespace: 'AWS/Lambda', Threshold: 1 });
  });
});

describe('アラーム全般', () => {
  // 復旧も通知しないと、直ったかどうかが Slack だけでは分からない
  it('すべてのアラームが ALARM と OK の両方をトピックへ送る', () => {
    expect(alarms().length).toBeGreaterThan(0);
    for (const a of alarms()) {
      expect(a.Properties.AlarmActions, a.Properties.AlarmName).toEqual([TOPIC_ARN_REF]);
      expect(a.Properties.OKActions, a.Properties.AlarmName).toEqual([TOPIC_ARN_REF]);
    }
  });

  it('アラーム名はすべて sakekasu-integrated- で始まる（Slack で「共通基盤」と出るように）', () => {
    for (const a of alarms()) expect(a.Properties.AlarmName).toMatch(/^sakekasu-integrated-/);
  });

  it('欠損を異常とみなすのは「外形監視が動いていない」だけ', () => {
    const breaching = alarms().filter((a) => a.Properties.TreatMissingData === 'breaching');
    expect(breaching.map((a) => a.Properties.AlarmName)).toEqual(['sakekasu-integrated-watcher-silent-health-check']);
    for (const a of alarms()) {
      if (a.Properties.TreatMissingData !== 'breaching') expect(a.Properties.TreatMissingData).toBe('notBreaching');
    }
  });
});

describe('AWS Health', () => {
  it('障害と予定された変更をトピックへ流すルールがある', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'sakekasu-integrated-aws-health',
      EventPattern: { source: ['aws.health'], detail: { eventTypeCategory: ['issue', 'scheduledChange'] } },
      Targets: [Match.objectLike({ Arn: TOPIC_ARN_REF })],
    });
  });
});

describe('外形監視', () => {
  it('cdk.json の対象に、4 アプリと共通ログインが入っている', () => {
    const urls = healthChecks.map((t) => t.url);
    for (const host of ['sakekasu-builder.com', 'kakeibo.', 'learning.', 'reinvent.', 'auth.sakekasu-builder.com']) {
      expect(urls.some((u) => u.includes(host)), host).toBe(true);
    }
  });

  it('5 分ごとに回す', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'sakekasu-integrated-health-check-schedule',
      ScheduleExpression: 'rate(5 minutes)',
      Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^HealthCheckFunction'), 'Arn'] } })],
    });
  });

  it('対象は Lambda に JSON の環境変数で渡す', () => {
    const fn = (Object.values(template.findResources('AWS::Lambda::Function')) as Resource[]).find(
      (f) => f.Properties.FunctionName === 'sakekasu-integrated-health-check',
    )!;
    const vars = fn.Properties.Environment.Variables;
    expect(JSON.parse(vars.HEALTH_CHECK_TARGETS)).toEqual(healthChecks);
    expect(vars.METRIC_NAMESPACE).toBe(METRIC_NAMESPACE);
  });

  it.each(healthChecks.map((t) => [t.name]))('%s: 5 分 × 2 回続けて失敗したら鳴る', (name) => {
    const a = alarm(`sakekasu-integrated-health-check-${name}`);
    expect(a.Properties).toMatchObject({
      Namespace: METRIC_NAMESPACE,
      MetricName: 'HealthCheckFailed',
      Dimensions: [{ Name: 'Target', Value: name }],
      Statistic: 'Maximum',
      Period: 300,
      EvaluationPeriods: 2,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  it('メトリクスの書き込みは自分の名前空間だけ', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Condition: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } },
          }),
        ]),
      },
    });
  });
});

describe('監視の監視', () => {
  it('外形監視の実行失敗を見る', () => {
    const a = alarm('sakekasu-integrated-watcher-failure-health-check');
    expect(a.Properties).toMatchObject({ MetricName: 'Errors', Period: 3600, Threshold: 1 });
  });

  // スケジュールが止まるとエラーすら出ず、静かに監視が消える
  it('外形監視が 1 時間動いていなければ鳴る', () => {
    const a = alarm('sakekasu-integrated-watcher-silent-health-check');
    expect(a.Properties).toMatchObject({
      MetricName: 'Invocations',
      Period: 3600,
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
  });
});

describe('Lambda とロググループ', () => {
  it('関数名はどちらも sakekasu-integrated- で始まり、Node.js 22 で動く', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Resource[];
    expect(fns.map((f) => f.Properties.FunctionName).sort()).toEqual([
      'sakekasu-integrated-health-check',
      'sakekasu-integrated-slack-notifier',
    ]);
    for (const f of fns) expect(f.Properties.Runtime).toBe('nodejs22.x');
  });

  it('ロググループを明示して作り、保持は 30 日。スタックを消してもログは残す', () => {
    const groups = template.findResources('AWS::Logs::LogGroup');
    const names = Object.values(groups).map((g) => (g as Resource).Properties.LogGroupName).sort();
    expect(names).toEqual(['/aws/lambda/sakekasu-integrated-health-check', '/aws/lambda/sakekasu-integrated-slack-notifier']);
    for (const g of Object.values(groups)) {
      expect((g as Resource).Properties.RetentionInDays).toBe(30);
      expect((g as { DeletionPolicy?: string }).DeletionPolicy).toBe('Retain');
    }
  });

  it('保持期間を付けるためのカスタムリソース（logRetention）を使わない', () => {
    template.resourceCountIs('Custom::LogRetention', 0);
  });

  it('ロール名は sakekasu-integrated-app- で始まる（cdkd 用ロールが作れる範囲）', () => {
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as Resource[];
    expect(roles.map((r) => r.Properties.RoleName).sort()).toEqual([
      'sakekasu-integrated-app-health-check',
      'sakekasu-integrated-app-slack-notifier',
    ]);
  });

  it('AWS 管理ポリシーを付けず、ログの書き込みは自分のロググループだけ', () => {
    for (const r of Object.values(template.findResources('AWS::IAM::Role')) as Resource[]) {
      expect(r.Properties.ManagedPolicyArns).toBeUndefined();
    }
    const logStatements = (Object.values(template.findResources('AWS::IAM::Policy')) as Resource[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, any>>)
      .filter((s) => JSON.stringify(s.Action).includes('logs:'));
    expect(logStatements).toHaveLength(2);
    for (const s of logStatements) {
      expect(s.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
      expect(JSON.stringify(s.Resource)).toMatch(/LogGroup/);
    }
  });
});

describe('us-east-1 の転送スタック', () => {
  it('グローバルの Health イベントを拾い、監視リージョンの default バスへ転送する', () => {
    globalTemplate.hasResourceProperties('AWS::Events::Rule', {
      Name: 'sakekasu-integrated-aws-health-global',
      EventPattern: { source: ['aws.health'], detail: { eventTypeCategory: ['issue', 'scheduledChange'] } },
      Targets: [Match.objectLike({ Arn: Match.anyValue(), RoleArn: Match.anyValue() })],
    });
    const rule = Object.values(globalTemplate.findResources('AWS::Events::Rule'))[0] as Resource;
    expect(JSON.stringify(rule.Properties.Targets[0].Arn)).toContain(':events:ap-northeast-1:');
    expect(JSON.stringify(rule.Properties.Targets[0].Arn)).toContain(':event-bus/default');
  });

  it('転送ロールの権限は宛先のバスへの PutEvents だけ', () => {
    const policies = Object.values(globalTemplate.findResources('AWS::IAM::Policy')) as Resource[];
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('events:PutEvents');
    expect(JSON.stringify(statements[0].Resource)).toContain(':events:ap-northeast-1:');
    expect(JSON.stringify(statements[0].Resource)).not.toContain('us-east-1');
  });

  // 条件が無いと、同じアカウントで別のルールを作れる相手がこのロールで監視バスへ流し込める
  it('ロールを引き受けられるのは、このルールの EventBridge だけ', () => {
    globalTemplate.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'sakekasu-integrated-app-health-forwarder',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'events.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': ACCOUNT },
              ArnEquals: { 'aws:SourceArn': `arn:aws:events:us-east-1:${ACCOUNT}:rule/sakekasu-integrated-aws-health-global` },
            },
          }),
        ],
      },
    });
  });

  it('作るのはルールとロールだけ（SNS も Lambda も置かない）', () => {
    globalTemplate.resourceCountIs('AWS::Events::Rule', 1);
    globalTemplate.resourceCountIs('AWS::SNS::Topic', 0);
    globalTemplate.resourceCountIs('AWS::Lambda::Function', 0);
  });

  it('監視のスタックを参照しない（Fn::ImportValue もクロスリージョン参照も無い）', () => {
    const json = JSON.stringify(globalTemplate.toJSON());
    expect(json).not.toContain('Fn::ImportValue');
    expect(json).not.toContain('Custom::CrossRegion');
  });
});

describe('ロールの Permissions Boundary', () => {
  const BOUNDARY_SUFFIX = ':policy/sakekasu-integrated-role-boundary';

  it.each([
    ['monitoring', () => template],
    ['health-global', () => globalTemplate],
  ])('%s のロールはすべて境界の内側にある', (_name, get) => {
    const roles = Object.values(get().findResources('AWS::IAM::Role')) as Resource[];
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(JSON.stringify(role.Properties.PermissionsBoundary), role.Properties.RoleName).toContain(BOUNDARY_SUFFIX);
    }
  });

  // 付くと cdkd 用ロールの IAM が拒否され、監視のロールを作れなくなる
  it('GitHub Actions の cdkd 用ロールには付けない', () => {
    const t = Template.fromStack(
      new CdkdDeployStack(new cdk.App(), 'test-cdkd', { repository: 'yuuuuuuu168/sakekasu-integrated_environment', env }),
    );
    for (const role of Object.values(t.findResources('AWS::IAM::Role')) as Resource[]) {
      expect(role.Properties.PermissionsBoundary).toBeUndefined();
    }
  });

  // IAM の description は ASCII + Latin-1 しか受け付けず、日本語を入れるとデプロイが 400 で落ちる
  it('IAM ロールの説明に ASCII 以外を混ぜない', () => {
    for (const t of [template, globalTemplate]) {
      for (const role of Object.values(t.findResources('AWS::IAM::Role')) as Resource[]) {
        const description = role.Properties.Description as string | undefined;
        expect(description, role.Properties.RoleName).toBeDefined();
        expect(/^[\x20-\x7E]*$/.test(description!), description).toBe(true);
      }
    }
  });
});
