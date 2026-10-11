import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApexRedirectStack, redirectFunctionCode } from '../lib/apex-redirect-stack';
import { APEX_DOMAINS } from '../lib/names';
import { PORTAL_APPS, portalHtmlFromThemeFile } from '../lib/portal';

const env = { account: '123456789012', region: 'us-east-1' };
const TARGET = 'sake.sakekasu-builder.com';
const CERT = 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000';

interface CfRequest {
  uri: string;
  querystring: Record<string, { value: string; multiValue?: { value: string }[] }>;
}
interface CfResponse {
  statusCode: number;
  headers: Record<string, { value: string }>;
  body?: { encoding: string; data: string };
}

const PORTAL = portalHtmlFromThemeFile();

/** CloudFront Functions の本体を Node で走らせる（文法は ES5 相当なのでそのまま動く） */
function runRedirect(request: CfRequest): CfResponse {
  const handler = new Function(`${redirectFunctionCode(TARGET, PORTAL)}; return handler;`)() as (event: {
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

  it('トップは 4 アプリへの入口のページを返す', () => {
    for (const uri of ['/', '/index.html']) {
      const res = runRedirect({ uri, querystring: {} });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type'].value).toBe('text/html; charset=utf-8');
      expect(res.body?.data).toBe(PORTAL);
      for (const app of PORTAL_APPS) {
        expect(res.body?.data).toContain(`href="${app.url}"`);
        expect(res.body?.data).toContain(app.label);
      }
    }
  });

  it('入口のページは外のものを読まない（CSP）', () => {
    const csp = runRedirect({ uri: '/', querystring: {} }).headers['content-security-policy'].value;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(PORTAL).not.toMatch(/<script|<link|src=/);
  });

  it('関数のコードは CloudFront Functions の上限（10 KB）に収まり、ASCII だけ', () => {
    const code = redirectFunctionCode(TARGET, PORTAL);
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
      }),
    });
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
