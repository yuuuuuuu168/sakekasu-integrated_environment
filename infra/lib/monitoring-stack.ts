import * as path from 'node:path';
import * as url from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { HealthCheckTarget } from './health-checks';
import { lambdaLogGroup } from './log-retention';
import { ALERT_TOPIC_NAME, APP_ROLE_PREFIX, PREFIX, SLACK_WEBHOOK_PARAMETER_NAME } from './names';
import { applyRoleBoundary } from './role-boundary';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** 外形監視が書くメトリクスの名前空間 */
export const METRIC_NAMESPACE = `${PREFIX}-monitoring`;

/** AWS Health のうち通知するもの。お知らせや調査中まで拾うと日常的に鳴るので、障害と予定された変更に絞る */
export const HEALTH_EVENT_CATEGORIES = ['issue', 'scheduledChange'];

export interface MonitoringStackProps extends cdk.StackProps {
  /** 外形監視の対象（cdk.json の context `healthChecks`。parseHealthChecks を通したもの） */
  healthChecks: HealthCheckTarget[];
}

/**
 * 4 アプリ共通の監視と Slack 通知（docs/monitoring.md）。作りは sakekasu-builder の
 * lib/monitoring-stack.ts から、共通基盤が持つ分だけを写した。
 *
 * 共通基盤が持つのは次の 3 つだけ。アプリごとのアラーム（Lambda のエラーなど）は各アプリが
 * 自分のリポジトリで持ち、ここのトピックへ送る。
 *
 *   - 通知の経路: SNS トピック `sakekasu-integrated-alerts` → Slack 通知 Lambda → Slack
 *   - AWS Health: 障害と予定された変更（us-east-1 のグローバル分は HealthGlobalStack が転送してくる）
 *   - 全サイトの死活監視: 5 分ごとの外形監視と、その監視の監視
 *
 * Slack の Webhook URL はリポジトリに置けないので、人が手で SSM に登録したものを名前で読む。
 */
export class MonitoringStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // このスタックのロールはすべて Permissions Boundary の内側に置く。cdkd 用ロールは
    // 境界の付いたロールしか作れない条件になっているので、外すとデプロイが止まる（lib/role-boundary.ts）
    applyRoleBoundary(this);

    // --- 通知の経路 ---

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      // 固定名。各アプリはこの名前から ARN を組み立てて送る。変えると全アプリの通知が止まる
      topicName: ALERT_TOPIC_NAME,
      displayName: 'sakekasu monitoring alerts',
    });

    /*
     * 送ってよい相手をトピックポリシーで明示する。
     *
     * SNS はトピックを作ると「所有アカウントからの publish を許す」既定のポリシーを暗黙に持ち、
     * CloudWatch アラームの通知はこれに乗っている。だが明示的なトピックポリシーを 1 つでも置くと、
     * この既定は丸ごと置き換わる。sakekasu-builder では AWS Health のルール（EventBridge）を
     * 足したときに CDK が events.amazonaws.com だけを許すポリシーを生成し、アラームの通知が
     * 9 日間届かなくなった（2026-08-06 〜 08-17。アラームの状態は正しく遷移するので気づけなかった）。
     *
     * ここでは CloudWatch と EventBridge の両方を、最初から条件付きで明示する。
     * 条件は AWS が渡すと明記しているキー（aws:SourceAccount と aws:SourceArn）だけにする。
     * 推測で絞ると「鳴っているのに届かない」という同じ壊れ方をする。
     *
     * 同じアカウントの IAM ロール（Lambda など）から直接 publish する場合は、そのロールの
     * アイデンティティポリシーに sns:Publish があれば届く（同一アカウントはどちらか一方の許可で足りる）。
     *
     * 壊れていないかは、アラームのアクションの履歴で見る（docs/monitoring.md）。
     * 出典: https://repost.aws/knowledge-center/cloudwatch-receive-sns-for-alarm-trigger
     */
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          // 4 アプリのどのアラームからも受ける。リージョンは絞らない（アプリが us-east-1 に置いた
          // アラームから送れるかは未確認だが、ここで弾く理由も無い）
          ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:*:${this.account}:alarm:*` },
        },
      }),
    );
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgeRulesToPublish',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:events:*:${this.account}:rule/*` },
        },
      }),
    );

    const slackNotifier = this.lambda('SlackNotifier', 'slack-notifier', {
      timeout: cdk.Duration.seconds(15),
      environment: { WEBHOOK_PARAMETER_NAME: SLACK_WEBHOOK_PARAMETER_NAME },
    });

    // Webhook URL は手で登録したパラメータ 1 つだけ読める。SecureString の復号は
    // AWS 管理キー（aws/ssm）で、そのキーポリシーが同じアカウントの SSM 経由の利用を許しているので、
    // kms:Decrypt を足す必要は無い（カスタマー管理キーに変えたときは要る）
    slackNotifier.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadSlackWebhookUrl',
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SLACK_WEBHOOK_PARAMETER_NAME}`,
        ],
      }),
    );

    this.alertTopic.addSubscription(new subscriptions.LambdaSubscription(slackNotifier));

    // Slack への通知そのものが失敗すると誰も気づけないので、ここも監視する。
    // 届かない通知の通知も同じ経路を通るが、OK に戻ったときの通知で「途切れていた」ことは分かる
    this.addAlarm('SlackNotifierFailure', {
      alarmName: `${PREFIX}-slack-notifier-failure`,
      description:
        'Slack への通知に失敗しています。アラートが届かない状態です。' +
        'SSM の Webhook URL が登録されているか、Slack 側で無効になっていないかを確認してください',
      metric: slackNotifier.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // --- AWS Health ---

    // 自分たちのコードでは直せない AWS 側の障害・メンテナンスを受け取る。アカウント全体の話なので
    // 共通基盤だけが持つ（各アプリが持つと同じ通知が何通も届く）。
    // グローバルサービス（IAM、CloudFront など）のイベントは us-east-1 にしか来ないので、
    // HealthGlobalStack がこのリージョンの default バスへ転送してくる。同じ形でこのバスに入るので、
    // ルールはここ 1 本で済む
    new events.Rule(this, 'AwsHealthRule', {
      ruleName: `${PREFIX}-aws-health`,
      description: 'AWS Health issues and scheduled changes to the shared alert topic',
      eventPattern: {
        source: ['aws.health'],
        detail: { eventTypeCategory: HEALTH_EVENT_CATEGORIES },
      },
      // targets.SnsTopic は events.amazonaws.com に無条件の publish を許す文をトピックポリシーへ足す。
      // 上で条件付きの文を置いてあるので、ここではトピックの ARN を渡すだけにする
      targets: [{ bind: () => ({ arn: this.alertTopic.topicArn }) }],
    });

    // --- 外形監視（5 分ごと）---

    const healthCheck = this.lambda('HealthCheck', 'health-check', {
      timeout: cdk.Duration.seconds(60),
      environment: {
        METRIC_NAMESPACE,
        HEALTH_CHECK_TARGETS: JSON.stringify(props.healthChecks),
        TIMEOUT_MS: '10000',
      },
    });
    healthCheck.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PutHealthCheckMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } },
      }),
    );

    new events.Rule(this, 'HealthCheckSchedule', {
      ruleName: `${PREFIX}-health-check-schedule`,
      description: 'Runs the external health check every 5 minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(healthCheck)],
    });

    /*
     * 対象ごとのアラーム。一時的な失敗で鳴らさないよう、5 分 × 2 回続けて失敗したら通知する。
     *
     * 共通ログインは 2 つ見ている（cdk.json の healthChecks）。
     *   - auth: ログイン画面（auth.sakekasu-builder.com/login に、登録済みのクライアント ID と
     *     戻り先を付けたもの）。利用者が実際に通る独自ドメイン（CloudFront と証明書）と
     *     マネージドログインが生きていれば、ログイン画面の HTML が 200 で返る。引数無しの
     *     /oauth2/authorize などはエラー画面へのリダイレクトになり、応答が Cognito の都合で
     *     変わりうるので使わない
     *   - auth-issuer: 発行者の OIDC 設定（cognito-idp の .well-known/openid-configuration）。
     *     各アプリのバックエンドが JWT の検証に使う公開鍵の在りかで、ユーザープールがあれば
     *     必ず 200 の JSON を返す（2026-10-03 に確認）。独自ドメインの不調とユーザープール自体の
     *     不調を見分けられる
     */
    for (const target of props.healthChecks) {
      this.addAlarm(`HealthCheckFailed-${target.name}`, {
        alarmName: `${PREFIX}-health-check-${target.name}`,
        description: `外形監視で ${target.name}（${target.url}）が期待した応答（${target.expectStatus.join('/')}）を返していません`,
        metric: new cloudwatch.Metric({
          namespace: METRIC_NAMESPACE,
          metricName: 'HealthCheckFailed',
          dimensionsMap: { Target: target.name },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 2,
      });
    }

    // --- 監視の監視 ---

    // 外形監視そのものが動かなくなると、サイトが落ちても気づけない。「エラーで失敗した」だけでなく
    // 「そもそも動いていない」も見る（スケジュールが止まるとエラーすら記録されず、静かに監視が消える）
    this.addAlarm('WatcherFailure-health-check', {
      alarmName: `${PREFIX}-watcher-failure-health-check`,
      description: '外形監視の実行自体が失敗しています。サイトの異常を検知できない状態です',
      metric: healthCheck.metricErrors({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    this.addAlarm('WatcherSilent-health-check', {
      alarmName: `${PREFIX}-watcher-silent-health-check`,
      description: '外形監視が動いていません。スケジュールの停止や権限の失効が疑われます',
      // 5 分ごとに動くので、1 時間あれば必ず実行されている
      metric: healthCheck.metricInvocations({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      // Invocations は呼び出しが無いと 0 ではなく「記録なし」になる。記録が無い＝動いていない、とみなす
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: '4 アプリ共通の通知先トピック（各アプリのアラームの送り先）',
    });
    new cdk.CfnOutput(this, 'AlertTopicName', {
      value: this.alertTopic.topicName,
      description: '通知先トピックの名前（ARN はこの名前とアカウント・リージョンから組み立てる）',
    });
    new cdk.CfnOutput(this, 'SlackWebhookParameterName', {
      value: SLACK_WEBHOOK_PARAMETER_NAME,
      description: 'Slack の Webhook URL を置く SSM パラメータ（SecureString。手で登録する）',
    });
  }

  /**
   * 監視の Lambda を作る。名前・ロール・ロググループはどれも `sakekasu-integrated-` で始め、
   * cdkd 用ロールの許可の範囲（cdkd-deploy-stack.ts）に収める。
   *
   * ロールは明示して作り、名前を `sakekasu-integrated-app-*` にする。CDK に任せると
   * 自動生成の名前になり、cdkd 用ロールが作れる範囲を名前で絞れない。
   * AWS 管理ポリシー（AWSLambdaBasicExecutionRole）は付けず、ログの書き込みは
   * この関数のロググループだけに絞る。
   */
  private lambda(
    id: string,
    slug: string,
    props: Pick<NodejsFunctionProps, 'timeout' | 'environment'>,
  ): NodejsFunction {
    const functionName = `${PREFIX}-${slug}`;
    const logGroup = lambdaLogGroup(this, `${id}LogGroup`, functionName);
    const role = new iam.Role(this, `${id}Role`, {
      roleName: `${APP_ROLE_PREFIX}${slug}`,
      // IAM の description は ASCII + Latin-1 のみ。日本語を入れるとデプロイが 400 で落ちる
      description: `Execution role for ${functionName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    logGroup.grantWrite(role);

    return new NodejsFunction(this, `${id}Function`, {
      functionName,
      role,
      logGroup,
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(here, `../lambda/${slug}/index.ts`),
      handler: 'handler',
      memorySize: 256,
      ...props,
      bundling: {
        // AWS SDK（client-ssm、client-cloudwatch）はランタイム同梱のものを使い、バンドルに入れない。
        // 使う API は GetParameter と PutMetricData だけで、同梱の版で足りる
        externalModules: ['@aws-sdk/*'],
        // テストやローカルの合成で、実行のたびにハッシュが変わらないようにする
        sourceMap: false,
      },
    });
  }

  private addAlarm(
    id: string,
    options: {
      alarmName: string;
      description: string;
      metric: cloudwatch.IMetric;
      threshold: number;
      evaluationPeriods: number;
      /** 既定は「しきい値以上で異常」 */
      comparisonOperator?: cloudwatch.ComparisonOperator;
      /** 既定は「データが無い期間は異常なし」（呼び出しが無い時間帯に鳴らさない） */
      treatMissingData?: cloudwatch.TreatMissingData;
    },
  ): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: options.alarmName,
      alarmDescription: options.description,
      metric: options.metric,
      threshold: options.threshold,
      evaluationPeriods: options.evaluationPeriods,
      comparisonOperator:
        options.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: options.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // 発報だけでなく復旧も通知して、直ったかどうかが Slack だけで分かるようにする
    alarm.addAlarmAction(new actions.SnsAction(this.alertTopic));
    alarm.addOkAction(new actions.SnsAction(this.alertTopic));
    return alarm;
  }
}
