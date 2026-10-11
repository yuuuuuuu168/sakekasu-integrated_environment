import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as fs from 'node:fs';
import { APPLE_TOUCH_ICON_PATH, ApexRedirectStack, iconFunctionCode, redirectFunctionCode } from '../lib/apex-redirect-stack';
import { APEX_DOMAINS } from '../lib/names';
import {
  PORTAL_APPS,
  PORTAL_ICON_URL,
  portalManifestFromThemeFile,
  portalPartsFromThemeFile,
  renderPage,
} from '../lib/portal';

const env = { account: '123456789012', region: 'us-east-1' };
const TARGET = 'sake.sakekasu-builder.com';
const CERT = 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000';
const LOGIN = { authDomain: 'auth.example.com', origin: 'https://example.com', clientId: 'portalclient123' };

interface CfRequest {
  uri: string;
  querystring: Record<string, { value: string; multiValue?: { value: string }[] }>;
}
interface CfResponse {
  statusCode: number;
  headers: Record<string, { value: string }>;
  body?: { encoding: string; data: string };
}

const PARTS = portalPartsFromThemeFile();
const TOP = renderPage(PARTS, 'top');
const APPS = renderPage(PARTS, 'apps');

/** CloudFront Functions の本体を Node で走らせる（文法は ES5 相当なのでそのまま動く） */
function runRedirect(request: CfRequest, login: typeof LOGIN | undefined = LOGIN): CfResponse {
  const handler = new Function(`${redirectFunctionCode(TARGET, PARTS, login)}; return handler;`)() as (event: {
    request: CfRequest;
  }) => CfResponse;
  return handler({ request });
}

describe('転送の関数', () => {
  it('パスを保ったまま 301 で転送する', () => {
    const res = runRedirect({ uri: '/records', querystring: {} });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location.value).toBe(`https://${TARGET}/records`);
  });

  it('トップは表紙を返し、「パスキーでログイン」は /apps へ行く', () => {
    for (const uri of ['/', '/index.html']) {
      const res = runRedirect({ uri, querystring: {} });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type'].value).toBe('text/html; charset=utf-8');
      expect(res.body?.data).toBe(TOP);
    }
    expect(TOP).toContain('href="/apps"');
    expect(TOP).toContain('パスキーでログイン');
  });

  it('/apps は code が無ければ共通ログインへ送る（ログイン画面は日本語）', () => {
    const res = runRedirect({ uri: '/apps', querystring: {} });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location.value).toBe(
      'https://auth.example.com/oauth2/authorize?client_id=portalclient123&response_type=code&scope=openid&lang=ja' +
        '&redirect_uri=https%3A%2F%2Fexample.com%2Fapps',
    );
    expect(res.headers['cache-control'].value).toBe('no-store');
  });

  it('/apps は共通ログインから code 付きで戻ったら 4 アプリの一覧を返す', () => {
    const res = runRedirect({ uri: '/apps', querystring: { code: { value: 'abc' } } });
    expect(res.statusCode).toBe(200);
    expect(res.body?.data).toBe(APPS);
    expect(res.headers['cache-control'].value).toBe('no-store');
    for (const app of PORTAL_APPS) {
      expect(APPS).toContain(`href="${app.url}"`);
      expect(APPS).toContain(app.label);
    }
    expect(APPS).toContain('href="/logout"');
    // 各アプリに「入口でログイン済み」と伝え、サインインのボタンを省かせる
    for (const app of PORTAL_APPS) expect(new URL(app.url).searchParams.get('sso')).toBe('1');
  });

  it('/apps に error 付きで戻ったら表紙へ', () => {
    const res = runRedirect({ uri: '/apps', querystring: { error: { value: 'access_denied' } } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location.value).toBe('/');
  });

  it('/logout は共通ログインのセッションを消して表紙へ戻る', () => {
    const res = runRedirect({ uri: '/logout', querystring: {} });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location.value).toBe(
      'https://auth.example.com/logout?client_id=portalclient123&logout_uri=https%3A%2F%2Fexample.com%2F',
    );
  });

  it('クライアント ID が無いうちは、/apps は共通ログインを通さずに一覧を返す', () => {
    const login = { ...LOGIN, clientId: undefined } as unknown as typeof LOGIN;
    expect(runRedirect({ uri: '/apps', querystring: {} }, login).body?.data).toBe(APPS);
    expect(runRedirect({ uri: '/logout', querystring: {} }, login).headers.location.value).toBe('/');
  });

  it('入口のページは日本語として表示する（lang と日本語のフォントを先に）', () => {
    for (const html of [TOP, APPS]) {
      expect(html).toContain('<html lang="ja">');
      expect(html).toMatch(/font-family:'Hiragino Sans'/);
      expect(html).not.toContain('system-ui');
    }
  });

  it('入口のページは外のものもスクリプトも読まない（CSP）', () => {
    const csp = runRedirect({ uri: '/', querystring: {} }).headers['content-security-policy'].value;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 読むのはホーム画面のアイコン（同じオリジン）だけ
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    for (const html of [TOP, APPS]) {
      expect(html.replace(/<link rel="(manifest|apple-touch-icon)"[^>]*>/g, '')).not.toMatch(/<script|<link|src=|url\(/);
    }
  });

  it('入口のページはホーム画面のアイコンとマニフェストを指す', () => {
    for (const html of [TOP, APPS]) {
      expect(html).toContain(`<link rel="apple-touch-icon" sizes="192x192" href="${PORTAL_ICON_URL}">`);
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    }
  });

  it('関数のコードは CloudFront Functions の上限（10 KB）に収まり、ASCII だけ', () => {
    const code = redirectFunctionCode(TARGET, PARTS, LOGIN);
    expect(Buffer.byteLength(code, 'utf8')).toBeLessThan(10 * 1024);
    expect(code).toMatch(/^[\x00-\x7f]*$/);
  });

  it('クエリは受け取ったままの形でつなぐ（同じキーが複数あっても落とさない）', () => {
    const res = runRedirect({
      uri: '/search',
      querystring: {
        q: { value: 'a%20b' },
        tag: { value: 'x', multiValue: [{ value: 'x' }, { value: 'y' }] },
        flag: { value: '' },
      },
    });
    expect(res.headers.location.value).toBe(`https://${TARGET}/search?q=a%20b&tag=x&tag=y&flag`);
  });

  it('HSTS を付ける（Amplify が apex に出していたものを落とさない）', () => {
    for (const uri of ['/', '/records']) {
      const res = runRedirect({ uri, querystring: {} });
      expect(res.headers['strict-transport-security'].value).toBe('max-age=31536000; includeSubDomains');
    }
  });
});

describe('ホーム画面のアイコンとマニフェスト', () => {
  const png = fs.readFileSync(APPLE_TOUCH_ICON_PATH);
  const manifest = portalManifestFromThemeFile();
  const code = iconFunctionCode(png, manifest);
  const run = (uri: string) =>
    (new Function(`${code}; return handler;`)() as (event: unknown) => CfResponse)({ request: { uri, querystring: {} } });

  it('192x192 の PNG をそのまま返す（URL の版や -precomposed でも同じ）', () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(192);
    expect(png.readUInt32BE(20)).toBe(192);
    for (const uri of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
      const res = run(uri);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type'].value).toBe('image/png');
      expect(res.body?.encoding).toBe('base64');
      expect(Buffer.from(res.body!.data, 'base64').equals(png)).toBe(true);
    }
  });

  it('マニフェストはアイコンを指し、ブラウザで開く', () => {
    const res = run('/manifest.webmanifest');
    expect(res.headers['content-type'].value).toBe('application/manifest+json');
    const body = JSON.parse(res.body!.data);
    expect(body).toMatchObject({ name: 'sakekasu', start_url: '/', display: 'browser' });
    expect(body.icons).toEqual([{ src: PORTAL_ICON_URL, sizes: '192x192', type: 'image/png', purpose: 'any' }]);
  });

  it('関数のコードは CloudFront Functions の上限（10 KB）に収まり、ASCII だけ', () => {
    expect(Buffer.byteLength(code, 'utf8')).toBeLessThan(10 * 1024);
    expect(code).toMatch(/^[\x00-\x7f]*$/);
  });
});

describe('ApexRedirectStack', () => {
  it('証明書が無いうちは独自ドメインを付けない（Amplify と同じドメインを取り合わない）', () => {
    const template = Template.fromStack(
      new ApexRedirectStack(new cdk.App(), 'test-apex', { targetDomain: TARGET, env }),
    );
    const [dist] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    expect(dist.Properties.DistributionConfig.Aliases).toBeUndefined();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
        CacheBehaviors: ['/apple-touch-icon*', '/manifest.webmanifest'].map((PathPattern) =>
          Match.objectLike({
            PathPattern,
            ViewerProtocolPolicy: 'redirect-to-https',
            FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
          }),
        ),
      }),
    });
    template.resourceCountIs('AWS::CloudFront::Function', 2);
  });

  it('証明書を渡すと apex と www を付け、TLS 1.2 以上にする', () => {
    const template = Template.fromStack(
      new ApexRedirectStack(new cdk.App(), 'test-apex', {
        targetDomain: TARGET,
        customDomain: { domainNames: APEX_DOMAINS, certificateArn: CERT },
        env,
      }),
    );
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['sakekasu-builder.com', 'www.sakekasu-builder.com'],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: CERT,
          MinimumProtocolVersion: 'TLSv1.2_2021',
        }),
      }),
    });
    // 証明書は作らない（cdkd は ACM の DNS 検証を扱えない）
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  });
});
