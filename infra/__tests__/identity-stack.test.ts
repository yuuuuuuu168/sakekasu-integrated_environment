import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IdentityStack, PASSWORD_MIN_LENGTH, type CustomAuthDomain } from '../lib/identity-stack';

const APPS = [
  { name: 'reinvent', callbackUrls: ['https://reinvent.example.com/'], logoutUrls: ['https://reinvent.example.com/'] },
  { name: 'kakeibo', callbackUrls: ['https://kakeibo.example.com/'], logoutUrls: ['https://kakeibo.example.com/'] },
];

function template(customDomain?: CustomAuthDomain) {
  const app = new cdk.App();
  const stack = new IdentityStack(app, 'test-identity', {
    apps: APPS,
    cognitoDomainPrefix: 'test-prefix',
    customDomain,
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
}

const CUSTOM: CustomAuthDomain = {
  domainName: 'auth.example.com',
  hostedZoneId: 'Z0000000000TEST',
  certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test',
};

describe('IdentityStack: ユーザープール', () => {
  it('新規登録を受け付けず、管理者だけがユーザーを作る', () => {
    template().hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('TOTP の MFA を必須にし、SMS は使わない', () => {
    template().hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
  });

  it('パスワードは 16 文字以上', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(16);
    template().hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 16 }) },
    });
  });

  it('消えない（作り直すと sub が変わり、各アプリのデータとのひも付けが切れる）', () => {
    template().hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtection: 'ACTIVE' }),
    });
  });
});

describe('IdentityStack: アプリクライアント', () => {
  it('アプリごとに 1 つ作る', () => {
    template().resourceCountIs('AWS::Cognito::UserPoolClient', APPS.length);
    template().resourceCountIs('AWS::Cognito::ManagedLoginBranding', APPS.length);
  });

  it('ログイン画面は Cognito の既定ではなく、共通テーマの色を使う', () => {
    const brandings = template().findResources('AWS::Cognito::ManagedLoginBranding');
    for (const b of Object.values(brandings)) {
      expect(b.Properties.UseCognitoProvidedValues).toBe(false);
      expect(b.Properties.Settings.components.primaryButton.lightMode.defaults.backgroundColor).toBe('1b365dff');
      expect(b.Properties.Settings.categories.global.colorSchemeMode).toBe('DYNAMIC');
    }
  });

  it('認可コードだけを使い、秘密を持たず、Cognito のユーザーだけを通す', () => {
    const clients = template().findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      const props = client.Properties;
      expect(props.AllowedOAuthFlows).toEqual(['code']);
      expect(props.AllowedOAuthFlowsUserPoolClient).toBe(true);
      expect(props.GenerateSecret).toBe(false);
      expect(props.SupportedIdentityProviders).toEqual(['COGNITO']);
      expect(props.PreventUserExistenceErrors).toBe('ENABLED');
      expect(props.EnableTokenRevocation).toBe(true);
    }
  });

  // ExplicitAuthFlows を省くと Cognito は SRP・カスタム認証・更新の 3 つを有効にする。
  // ログイン画面を通さないパスワードのログインを閉じるため、更新だけを明示する
  it('ログイン画面を通さないログインを許さず、トークンの更新だけを許す', () => {
    const clients = template().findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      expect(client.Properties.ExplicitAuthFlows).toEqual(['ALLOW_REFRESH_TOKEN_AUTH']);
    }
  });

  it('戻り先は設定した URL だけ', () => {
    template().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'sakekasu-integrated-kakeibo',
      CallbackURLs: ['https://kakeibo.example.com/'],
      LogoutURLs: ['https://kakeibo.example.com/'],
    });
  });
});

describe('IdentityStack: ログイン画面のドメイン', () => {
  it('独自ドメインが無いあいだは Cognito のドメインを使う', () => {
    const t = template();
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'test-prefix', ManagedLoginVersion: 2 });
    t.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('独自ドメインがあれば、そのドメインと別名レコードを作る', () => {
    const t = template(CUSTOM);
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'auth.example.com',
      CustomDomainConfig: { CertificateArn: CUSTOM.certificateArn },
    });
    t.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      HostedZoneId: CUSTOM.hostedZoneId,
      AliasTarget: Match.objectLike({
        DNSName: { 'Fn::GetAtt': [Match.anyValue(), 'CloudFrontDistribution'] },
      }),
    });
  });

  it('カスタムリソース（Lambda）を作らない', () => {
    const t = template(CUSTOM);
    t.resourceCountIs('AWS::Lambda::Function', 0);
    expect(Object.keys(t.findResources('Custom::AWS'))).toHaveLength(0);
  });
});
