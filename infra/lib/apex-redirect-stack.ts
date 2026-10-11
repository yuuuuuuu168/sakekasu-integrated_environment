import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFIX } from './names';
import { portalPartsFromThemeFile, type PortalParts } from './portal';

/** 入口の「パスキーでログイン」で使う共通ログイン */
export interface PortalLogin {
  /** ログイン画面のドメイン。例: auth.sakekasu-builder.com */
  authDomain: string;
  /** 入口のオリジン。共通ログインの戻り先（<origin>/apps）とログアウト後の戻り先（<origin>/）になる */
  origin: string;
  /**
   * 入口のアプリクライアント ID（cdk.json の context `portalClientId`）。
   * クライアントは共通ログインのスタックで作るので、デプロイして ID が出てから書く。
   * 無いうちは、/apps は共通ログインを通さずに一覧を出す
   */
  clientId?: string;
}

export interface ApexRedirectStackProps extends cdk.StackProps {
  /** 転送先のホスト名（https:// を付けない）。例: sake.sakekasu-builder.com */
  targetDomain: string;
  /** 入口のページ。省くと共通テーマから作る（lib/portal.ts） */
  portalParts?: PortalParts;
  /** 入口から共通ログインへ送るときの設定（docs/apex-redirect.md） */
  login?: PortalLogin;
  /**
   * 転送で受けるドメインと、その証明書（us-east-1、コンソールで作る）。
   * 無いうちは CloudFront の既定のドメイン（*.cloudfront.net）だけで作る。
   * 同じドメインは 2 つの CloudFront に同時に付けられないので、Amplify から外した後で渡す
   */
  customDomain?: { domainNames: string[]; certificateArn: string };
}

/**
 * iPhone の「ホーム画面に追加」で使うアイコン（180x180 の PNG）。
 * 元は同じディレクトリの apple-touch-icon.html で、Chromium で 180x180 に撮って 64 色に減らしたもの。
 * 関数のコードに base64 で埋め込むので、4 KB ほどに抑えてある
 */
export const APPLE_TOUCH_ICON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/apple-touch-icon.png');

/** JS の文字列リテラルにする。ASCII だけにして、関数のコードの文字コードに左右されないようにする */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * CloudFront Functions の本体。オリジンには一度も届かない。
 *
 * - `/`: 入口の表紙。「パスキーでログイン」は /apps へ行く
 * - `/apps`: 共通ログインから戻ったあとのアプリの一覧。`code` が無ければ共通ログイン
 *   （/oauth2/authorize）へ 302 で送る。共通ログインにセッションが残っていれば、入力なしで戻ってくる。
 *   ログイン画面は日本語で出す（lang=ja）。Cognito はこの指定をブラウザのクッキーに残すので、
 *   各アプリから開いたログイン画面も以後は日本語になる。`error` 付きで戻ったら表紙へ。コードは交換しない（一覧はリンクを並べるだけで、各アプリが
 *   自分でログインを確かめる。ここは流れを作るためで、守りではない）
 * - `/logout`: 共通ログインのセッションを消して（/logout）表紙へ戻る
 * - それ以外: パスとクエリを保ったまま転送先へ 301。builder を apex で使っていた頃のブックマークを生かす
 *
 * 文字列で持っているのはテストで中身を走らせるため（__tests__/apex-redirect-stack.test.ts）。
 * クエリの値は CloudFront が受け取ったまま（URL エンコードされたまま）渡ってくるので、
 * エンコードし直さずにつなぐ。
 *
 * HSTS も付ける。Amplify の配信が apex に includeSubDomains 付きで出していたもの
 * （sakekasu-builder の docs/amplify-exit.md）を、転送に切り替えても落とさない。
 */
export function redirectFunctionCode(targetDomain: string, parts: PortalParts, login?: PortalLogin): string {
  const authorize = login?.clientId
    ? `https://${login.authDomain}/oauth2/authorize?client_id=${encodeURIComponent(login.clientId)}` +
      `&response_type=code&scope=openid&lang=ja&redirect_uri=${encodeURIComponent(`${login.origin}/apps`)}`
    : '';
  const logout = login?.clientId
    ? `https://${login.authDomain}/logout?client_id=${encodeURIComponent(login.clientId)}` +
      `&logout_uri=${encodeURIComponent(`${login.origin}/`)}`
    : '/';
  return `var HEAD = ${jsString(parts.head)};
var CSS = ${jsString(parts.css)};
var TOP = ${jsString(parts.top)};
var APPS = ${jsString(parts.apps)};
var AUTHORIZE = ${jsString(authorize)};
var LOGOUT = ${jsString(logout)};
var HSTS = { value: 'max-age=31536000; includeSubDomains' };
function page(body, cache) {
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: 'text/html; charset=utf-8' },
      'strict-transport-security': HSTS,
      'content-security-policy': { value: "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
      'x-content-type-options': { value: 'nosniff' },
      'referrer-policy': { value: 'no-referrer' },
      'cache-control': { value: cache }
    },
    body: { encoding: 'text', data: HEAD + '<style>' + CSS + '</style></head><body>' + body + '</body></html>' }
  };
}
function found(location) {
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: { location: { value: location }, 'strict-transport-security': HSTS, 'cache-control': { value: 'no-store' } }
  };
}
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var qs = request.querystring;
  if (uri === '/' || uri === '/index.html') return page(TOP, 'max-age=300');
  if (uri === '/apps' || uri === '/apps/') {
    if (qs.error) return found('/');
    if (AUTHORIZE && !qs.code) return found(AUTHORIZE);
    return page(APPS, 'no-store');
  }
  if (uri === '/logout') return found(LOGOUT);
  var parts = [];
  for (var key in qs) {
    var entry = qs[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? key : key + '=' + values[i].value);
    }
  }
  var location = 'https://${targetDomain}' + uri + (parts.length ? '?' + parts.join('&') : '');
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: location },
      'strict-transport-security': HSTS,
      'cache-control': { value: 'max-age=3600' }
    }
  };
}
`;
}

/**
 * ホーム画面のアイコンを返す CloudFront Functions のコード。入口のページとは別の関数にする。
 * 関数のコードは 10 KB までで、入口のページだけで 8 KB 近く使っているため。
 * iPhone は `<link rel="apple-touch-icon">` が無くても /apple-touch-icon.png（と -precomposed.png）を
 * 取りに来るので、/apple-touch-icon で始まるパスにはどれも同じ画像を返す。
 */
export function iconFunctionCode(png: Buffer): string {
  return `var ICON = '${png.toString('base64')}';
function handler(event) {
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: 'image/png' },
      'strict-transport-security': { value: 'max-age=31536000; includeSubDomains' },
      'x-content-type-options': { value: 'nosniff' },
      'cache-control': { value: 'max-age=86400' }
    },
    body: { encoding: 'base64', data: ICON }
  };
}
`;
}

/**
 * apex（sakekasu-builder.com）と www。トップは 4 アプリへの入口のページを返し、それ以外のパスは
 * builder の画面（sake.sakekasu-builder.com）へ転送する。手順は docs/apex-redirect.md。
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
      comment: `Portal at / and /apps, redirect other paths to https://${props.targetDomain}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        redirectFunctionCode(props.targetDomain, props.portalParts ?? portalPartsFromThemeFile(), props.login),
      ),
    });

    const icon = new cloudfront.Function(this, 'IconFunction', {
      functionName: `${PREFIX}-apex-icon`,
      comment: 'Home screen icon for the portal (apple-touch-icon)',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(iconFunctionCode(fs.readFileSync(APPLE_TOUCH_ICON_PATH))),
    });

    // 関数が必ず応答を返すので、オリジンには届かない（defaultBehavior と同じ）
    const target = new origins.HttpOrigin(props.targetDomain);
    const custom = props.customDomain;
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${PREFIX} apex redirect`,
      defaultBehavior: {
        // ビューアーリクエストの関数が必ず応答を返すので、オリジンには届かない。
        // CloudFront はオリジンを 1 つ求めるので、転送先を置いておく
        origin: target,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [
          { function: redirect, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/apple-touch-icon*': {
          origin: target,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [{ function: icon, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
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
