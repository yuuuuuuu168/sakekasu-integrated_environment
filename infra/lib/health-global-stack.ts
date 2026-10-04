import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { HEALTH_EVENT_CATEGORIES } from './monitoring-stack';
import { APP_ROLE_PREFIX, PREFIX } from './names';
import { applyRoleBoundary } from './role-boundary';

export interface HealthGlobalStackProps extends cdk.StackProps {
  /** 転送先（監視のスタックがあるリージョン） */
  targetRegion: string;
}

/**
 * グローバルサービスの AWS Health イベントを拾うスタック。**us-east-1 に置く。**
 * 作りは sakekasu-builder の lib/health-global-stack.ts と同じ。
 *
 * IAM や CloudFront のようにリージョンを持たないサービスのイベントは us-east-1 にしか来ない。
 * EventBridge のターゲットに別リージョンの SNS は指定できないので、ここでは
 * 監視リージョン（ap-northeast-1）の default バスへ転送するだけにする。
 * 向こうの `sakekasu-integrated-aws-health` ルールが受け取り、Slack まで運ぶ。
 *
 * スタックの間は参照でつながない。転送先のバスの ARN はアカウントとリージョンから組み立てる。
 */
export class HealthGlobalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HealthGlobalStackProps) {
    super(scope, id, props);

    // ロールは Permissions Boundary の内側に置く（lib/role-boundary.ts）
    applyRoleBoundary(this);

    const targetBusArn = `arn:aws:events:${props.targetRegion}:${this.account}:event-bus/default`;
    const ruleName = `${PREFIX}-aws-health-global`;
    const ruleArn = `arn:aws:events:${this.region}:${this.account}:rule/${ruleName}`;

    // 転送のために、EventBridge に相手側のバスへの書き込みを許す。
    // 引き受けられる相手を「このルール」に限る。条件が無いと、同じアカウントで別のルールを
    // 作れる相手がこのロールを指定して、監視用のバスへ好きなイベントを流し込める
    const forwarderRole = new iam.Role(this, 'HealthForwarderRole', {
      roleName: `${APP_ROLE_PREFIX}health-forwarder`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnEquals: { 'aws:SourceArn': ruleArn },
        },
      }),
      // IAM の description は ASCII + Latin-1 のみ。日本語を入れるとデプロイが 400 で落ちる
      description: 'Forwards global AWS Health events to the monitoring region',
    });
    forwarderRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [targetBusArn],
      }),
    );

    new events.Rule(this, 'AwsHealthGlobalRule', {
      ruleName,
      description: 'Forwards global AWS Health events to the monitoring region',
      eventPattern: {
        source: ['aws.health'],
        // 絞り込みは転送先のルールと揃える
        detail: { eventTypeCategory: HEALTH_EVENT_CATEGORIES },
      },
      targets: [
        new targets.EventBus(events.EventBus.fromEventBusArn(this, 'TargetBus', targetBusArn), {
          role: forwarderRole,
        }),
      ],
    });

    new cdk.CfnOutput(this, 'ForwardsTo', {
      value: targetBusArn,
      description: 'グローバルの AWS Health イベントの転送先',
    });
  }
}
