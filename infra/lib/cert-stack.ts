import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface CertStackProps extends cdk.StackProps {
  domainName: string;
  hostedZoneId: string;
}

/**
 * 共通ログイン画面（Cognito のカスタムドメイン）の証明書。
 *
 * Cognito のカスタムドメインは裏で CloudFront を使うので、証明書は us-east-1 に置く。
 * 識別子のスタックとは参照でつながず、出力の ARN を cdk.json の authCertificateArn に
 * 書いて渡す（crossRegionReferences を使わない）。
 */
export class CertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'cdk.json の authCertificateArn に書く値',
    });
  }
}
