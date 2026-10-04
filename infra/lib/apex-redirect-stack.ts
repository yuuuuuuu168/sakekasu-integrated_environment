import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';
import { PREFIX } from './names';

export interface ApexRedirectStackProps extends cdk.StackProps {
  /** 転送先のホスト名（https:// を付けない）。例: sake.sakekasu-builder.com */
  targetDomain: string;
  /**
   * 転送で受けるドメインと、その証明書（us-east-1、コンソールで作る）。
   * 無いうちは CloudFront の既定のドメイン（*.cloudfront.net）だけで作る。
   * 同じドメインは 2 つの CloudFront に同時に付けられないので、Amplify から外した後で渡す
   */
  customDomain?: { domainNames: string[]; certificateArn: string };
}

/**
 * CloudFront Functions の本体。ビューアーリクエストで、パスとクエリを保ったまま転送先へ 301 を返す。
 * オリジンには一度も届かない。
 *
 * 文字列で持っているのはテストで中身を走らせるため（__tests__/apex-redirect-stack.test.ts）。
 * クエリの値は CloudFront が受け取ったまま（URL エンコードされたまま）渡ってくるので、
 * エンコードし直さずにつなぐ。
 *
 * HSTS も付ける。Amplify の配信が apex に includeSubDomains 付きで出していたもの
 * （sakekasu-builder の docs/amplify-exit.md）を、転送に切り替えても落とさない。
 */
export function redirectFunctionCode(targetDomain: string): string {
  return `function handler(event) {
  var request = event.request;
  var parts = [];
  var qs = request.querystring;
  for (var key in qs) {
    var entry = qs[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? key : key + '=' + values[i].value);
    }
  }
  var location = 'https://${targetDomain}' + request.uri + (parts.length ? '?' + parts.join('&') : '');
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: location },
      'strict-transport-security': { value: 'max-age=31536000; includeSubDomains' },
      'cache-control': { value: 'max-age=3600' }
    }
  };
}
`;
}

/**
 * apex（sakekasu-builder.com）と www を、builder の画面（sake.sakekasu-builder.com）へ転送する。
 * 手順は docs/apex-redirect.md。
 *
 * これまでは Amplify Hosting が apex で builder を配っていた。builder を sake. へ移したので
 * （sakekasu-builder の docs/sake-subdomain.md）、apex は特定のアプリのものではなく 4 アプリ共通の
 * ドメインになる。そのため builder ではなくこのリポジトリに置く。入口のページに変えるときもここで済む。
 *
 * apex の A レコードは、共通ログインの独自ドメイン（auth.sakekasu-builder.com）が要求する
 * （docs/identity.md）。この CloudFront に向けておけば、Amplify を消しても A レコードが残る。
 *
 * レコードと証明書の検証は、親ゾーンが Organization の管理アカウントにあるので、このスタックでは
 * 作らない（cdkd の権限が届かない）。管理アカウントで人が入れる。
 */
export class ApexRedirectStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ApexRedirectStackProps) {
    super(scope, id, props);

    const redirect = new cloudfront.Function(this, 'RedirectFunction', {
      functionName: `${PREFIX}-apex-redirect`,
      comment: `Redirect to https://${props.targetDomain} keeping the path and query`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(redirectFunctionCode(props.targetDomain)),
    });

    const custom = props.customDomain;
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${PREFIX} apex redirect`,
      defaultBehavior: {
        // ビューアーリクエストの関数が必ず応答を返すので、オリジンには届かない。
        // CloudFront はオリジンを 1 つ求めるので、転送先を置いておく
        origin: new origins.HttpOrigin(props.targetDomain),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [
          { function: redirect, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      ...(custom
        ? {
            domainNames: custom.domainNames,
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', custom.certificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: '親ゾーンの apex と www の A / AAAA（エイリアス）の向け先',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
