import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';
import type { AppClientConfig } from './apps';
import { PREFIX } from './names';

/** 共通ログイン画面を独自ドメインで出すときの設定。3 つそろったときだけ使う */
export interface CustomAuthDomain {
  domainName: string;
  hostedZoneId: string;
  /** us-east-1 の証明書（CertStack の出力） */
  certificateArn: string;
}

export interface IdentityStackProps extends cdk.StackProps {
  apps: AppClientConfig[];
  /** 独自ドメインがまだ無いあいだに使う、Cognito のドメインの接頭辞 */
  cognitoDomainPrefix: string;
  customDomain?: CustomAuthDomain;
}

/** パスワードの最小の長さ。利用者の指定で 16 文字以上にしている */
export const PASSWORD_MIN_LENGTH = 16;

/**
 * 4 つのアプリ（reinvent、builder、kakeibo、learning）で共有するログイン。
 *
 * - 利用者は本人だけ。新規登録は受け付けず、ユーザーは管理者が CLI で作る
 * - TOTP の MFA を必須にする（SMS とメールは使わない）
 * - ログイン画面は Cognito のマネージドログインを共通のドメインで出す。
 *   各アプリはそこへリダイレクトする（認可コード + PKCE）。ログイン画面のドメインに
 *   セッションが残るので、1 つのアプリでログインすれば、ほかのアプリは入力なしで入れる
 *
 * ユーザープールは消えない設定にしてある。作り直すとユーザーの sub が変わり、
 * 各アプリのデータとのひも付けが切れる。
 */
export class IdentityStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-users`,
      // マネージドログインの新しい画面とブランディングに要る
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true } },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: PASSWORD_MIN_LENGTH,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const domain = props.customDomain
      ? this.userPool.addDomain('Domain', {
          customDomain: {
            domainName: props.customDomain.domainName,
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'AuthCertificate',
              props.customDomain.certificateArn,
            ),
          },
          managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
        })
      : this.userPool.addDomain('Domain', {
          cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
          managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
        });

    if (props.customDomain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'AuthZone', {
        hostedZoneId: props.customDomain.hostedZoneId,
        zoneName: props.customDomain.domainName,
      });
      // UserPoolDomainTarget は裏でカスタムリソース（Lambda）を作り、非推奨の API も使う。
      // cdkd で扱いにくいので、ドメインの属性（CloudFrontDistribution）から直接つなぐ
      const target: route53.IAliasRecordTarget = {
        bind: () => ({
          dnsName: domain.cloudFrontEndpoint,
          hostedZoneId: route53Targets.CloudFrontTarget.getHostedZoneId(this),
        }),
      };
      new route53.ARecord(this, 'AuthAliasA', { zone, target: route53.RecordTarget.fromAlias(target) });
    }

    for (const app of props.apps) {
      const client = this.userPool.addClient(`Client-${app.name}`, {
        userPoolClientName: `${PREFIX}-${app.name}`,
        // ブラウザで動くアプリなので秘密は持たせない（PKCE で守る）
        generateSecret: false,
        authFlows: {},
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls: app.callbackUrls,
          logoutUrls: app.logoutUrls,
        },
        // Cognito のユーザーだけ。外部の ID プロバイダーからユーザーが作られないようにする
        supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
        preventUserExistenceErrors: true,
        enableTokenRevocation: true,
        accessTokenValidity: cdk.Duration.hours(1),
        idTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.days(30),
      });

      // 画面の色は後から共通テーマ（藍と金）に合わせる。いまは Cognito の既定のまま
      new cognito.CfnManagedLoginBranding(this, `Branding-${app.name}`, {
        userPoolId: this.userPool.userPoolId,
        clientId: client.userPoolClientId,
        useCognitoProvidedValues: true,
      });

      new cdk.CfnOutput(this, `ClientId-${app.name}`, {
        value: client.userPoolClientId,
        description: `${app.name} の cdk.json に渡すアプリクライアント ID`,
      });
    }

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    // 各アプリの API（JWT オーソライザー）が照合する発行者
    new cdk.CfnOutput(this, 'Issuer', { value: this.userPool.userPoolProviderUrl });
    new cdk.CfnOutput(this, 'AuthDomain', { value: domain.baseUrl() });
  }
}
