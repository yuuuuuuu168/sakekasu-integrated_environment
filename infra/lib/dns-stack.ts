import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface DnsStackProps extends cdk.StackProps {
  /** このアカウントで持つゾーンの名前。例: auth.sakekasu-builder.com */
  zoneName: string;
}

/**
 * 共通ログイン画面に使うサブドメインのゾーン。作りは sakekasu-kakeibo の DnsStack に倣った。
 *
 * 親の sakekasu-builder.com のゾーンは Organization の管理アカウントにあり、
 * CloudFormation / cdkd はそこにレコードを書けない。サブドメインのゾーンをこちらに置き、
 * 親から NS で委任してもらう。
 *
 * 順番を守らないと詰まる（docs/identity.md）。
 *
 *   1. このスタックを作る（NS 4 つが決まる）
 *   2. 親のゾーンに、このサブドメインの NS レコードを入れる（管理アカウントでの手作業）
 *   3. dig NS で委任が効いたことを確かめる
 *   4. cdk.json に authHostedZoneId を書く（証明書のスタックが作られる）
 *
 * 3 を飛ばすと証明書の DNS 検証が通らず、deploy が終わらない。
 * ゾーンは消えない設定にしてある。作り直すと NS が変わり、委任を入れ直すことになる。
 */
export class DnsStack extends cdk.Stack {
  public readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    this.zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: props.zoneName,
      comment: 'sakekasu の共通ログイン画面。親から委任されている',
    });
    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.zone.hostedZoneId,
      description: 'cdk.json の authHostedZoneId に書く値',
    });
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(' ', this.zone.hostedZoneNameServers ?? []),
      description: '親のゾーンに NS レコードとして入れる 4 つ',
    });
  }
}
