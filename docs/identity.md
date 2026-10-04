# 共通ログイン（identity）

4 つのアプリ（reinvent、builder、kakeibo、learning）で共有するログイン。
コードは `infra/lib/identity-stack.ts`、アプリの登録は `infra/cdk.json` の `apps` にある。

## 作り

- ユーザープールは 1 つ。新規登録は受け付けず、ユーザーは管理者が CLI で作る
- TOTP の MFA を必須にする。パスワードは 16 文字以上（英大文字・英小文字・数字を含む）
- ログイン画面は Cognito のマネージドログインを `auth.sakekasu-builder.com` で出す
- 各アプリはアプリクライアントを 1 つずつ持ち、ログイン画面へリダイレクトする（認可コード + PKCE）
- アプリクライアントが許すのはトークンの更新（`ALLOW_REFRESH_TOKEN_AUTH`）だけ。ログイン画面を通さない SRP やカスタム認証は閉じてある（`ExplicitAuthFlows` を省くと Cognito はこれらを有効にするので、明示している）
- ログイン画面のドメインにセッションが残るので、1 つのアプリでログインすれば、
  ほかのアプリは入力なしで入れる
- ユーザープールは消えない設定（RETAIN と削除保護）。作り直すと sub が変わり、
  各アプリのデータとのひも付けが切れる

## スタック

| スタック | リージョン | 作られる条件 | 中身 |
| --- | --- | --- | --- |
| `sakekasu-integrated-auth-dns` | ap-northeast-1 | context `authZone` | `auth.sakekasu-builder.com` のゾーン |
| `sakekasu-integrated-identity` | ap-northeast-1 | いつも | ユーザープール、ドメイン、アプリクライアント |

スタックの間は参照でつながない。ゾーン ID と証明書の ARN は `cdk.json` に書いて渡す。
ログイン画面の証明書（us-east-1）は cdkd では作らず、コンソールで作る（下の手順の 4）。

## デプロイ済みの値

各アプリの設定に渡す値。どれも秘密ではない（ブラウザに配る値）。

| 項目 | 値 |
| --- | --- |
| ユーザープール ID | `ap-northeast-1_yw1VDKtxW` |
| 発行者（JWT の `iss`） | `https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_yw1VDKtxW` |
| ログイン画面 | `https://auth.sakekasu-builder.com`（それまでは `https://sakekasu-integrated.auth.ap-northeast-1.amazoncognito.com`） |
| クライアント ID: reinvent | `7thbqs1omkqdgo6k922sqhefdi` |
| クライアント ID: builder | `iuv75jactiu7ffumrj71khmen` |
| クライアント ID: kakeibo | `2bsth1alaafgp1utsq3evraib5` |
| クライアント ID: learning | `290il92ijts07ap3unkae5ql8o` |
| `auth.sakekasu-builder.com` のゾーン ID | `Z05756913NB3G0RNTABHH`（2026-10-03 に親から委任済み） |
| ログイン画面の証明書（us-east-1） | `arn:aws:acm:us-east-1:<アプリのアカウント ID>:certificate/67bb48e9-8b29-4a94-8753-af9877847205`（2026-10-03 にコンソールで作成） |

## 独自ドメインを有効にする順番

独自ドメインが無いあいだ、ログイン画面は `https://sakekasu-integrated.auth.ap-northeast-1.amazoncognito.com` で出る。

1. `authZone` が入った状態でデプロイする。`sakekasu-integrated-auth-dns` の出力 `NameServers` に NS が 4 つ出る
2. Organization の管理アカウントにある `sakekasu-builder.com` のゾーンに、
   `auth` の NS レコードとして 4 つを入れる（手作業）
3. 委任が効いたことを確かめる。`dig NS auth.sakekasu-builder.com +short` が同じ 4 つを返せばよい。
   ここを飛ばすと、次の手順で証明書の DNS 検証が通らず、デプロイが終わらない
4. `cdk.json` に `authHostedZoneId`（1 の出力 `HostedZoneId`）を書く。そのうえで、ACM のコンソール
   （**バージニア北部 us-east-1**）で証明書を作る
   - 「証明書をリクエスト」→「パブリック証明書」→ ドメイン名 `auth.sakekasu-builder.com`、検証は DNS
   - 作ったら証明書を開き、「Route 53 でレコードを作成」を押す。このアカウントの
     `auth.sakekasu-builder.com` のゾーンに検証用の CNAME が入り、数分で「発行済み」になる
   - cdkd で作らないのは、cdkd が検証レコードを書かず、CDK の検証設定も ACM に渡せないため
     （2026-10-03 のデプロイで失敗した）。一度作れば ACM が自動で更新する
5. `cdk.json` に `authCertificateArn`（4 の証明書の ARN）を書いてデプロイする。
   ログイン画面が `https://auth.sakekasu-builder.com` に移る

Cognito の独自ドメインは、親のドメイン（`sakekasu-builder.com`）に A レコードがあることを求める。
いまは builder のサイト（Amplify）があるので満たしている。builder を sake. へ移した後は、apex を転送用の CloudFront に向けて満たし続ける（[apex-redirect.md](apex-redirect.md)）。

## ユーザーを作る

```sh
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username <メールアドレス> \
  --user-attributes Name=email,Value=<メールアドレス> Name=email_verified,Value=true
```

仮のパスワードがメールで届く。初回ログインでパスワードの変更と TOTP の登録を求められる。

## アプリを足す・戻り先を変える

`cdk.json` の `apps` に足す。戻り先（`callbackUrls`、`logoutUrls`）は、アプリが Cognito に渡す URL と
完全に一致させる（末尾の `/` も区別される）。https か `http://localhost` だけを受け付ける。

## デプロイ

main へのマージで `.github/workflows/deploy.yml` が cdkd で出す。ロールは 2 つある。

| ロール | 入れ方 | 権限 |
| --- | --- | --- |
| `sakekasu-integrated-github-actions-deploy` | Mac から一度だけ手で入れる | CDK bootstrap のロールへの AssumeRole と、スタックの出力の読み取りだけ |
| `sakekasu-integrated-github-actions-cdkd` | deploy ワークフローが毎回 CloudFormation で入れる | いまのスタックに要る操作だけ（下記） |

どちらも、このリポジトリの main で動く GitHub Actions だけが引き受けられる。

### 最初に一度だけ（Mac で）

書き込み権限のある認証情報で、デプロイ用ロールを入れる。

```sh
cd infra
npm ci
npx cdk deploy sakekasu-integrated-github-oidc -c github-oidc=true
```

CDK の bootstrap（ap-northeast-1）と cdkd の状態バケット（`cdkd-state-<アカウント>`）は、
同じアカウントの kakeibo・learning が用意済みなので、改めて打たなくてよい。

### cdkd 用ロールの権限

kakeibo は AdministratorAccess だが、こちらは権限を絞っている（`infra/lib/cdkd-deploy-stack.ts` と
`infra/lib/cdkd-monitoring-statements.ts`）。共通ログインと監視（[monitoring.md](monitoring.md)）の両方の分を持つ。

- IAM はロール `sakekasu-integrated-app-*`（監視の Lambda と、AWS Health の転送ルールのロール）だけ。
  作成と権限の書き換え（`CreateRole`、`PutRolePolicy`、`AttachRolePolicy` など）は、Permissions Boundary
  `sakekasu-integrated-role-boundary` が付いているときだけ許す。境界はこのスタック（CloudFormation）が作り、
  中身は監視に要る操作だけ（`infra/lib/role-boundary.ts`）。境界の無いロールの作成・書き換え、境界の取り外し、
  境界ポリシーの書き換え・削除は Deny する。信頼ポリシーの書き換え（`UpdateAssumeRolePolicy`）は持たない
- `iam:PassRole` は `sakekasu-integrated-app-*` を Lambda と EventBridge に渡すときだけ
- GitHub Actions のロール（`sakekasu-integrated-github-actions-*`）には IAM の操作を一切できない（Deny）
- Lambda、SNS、EventBridge のルール、CloudWatch のアラーム、ロググループは、名前が `sakekasu-integrated-` で
  始まるものだけ。操作は cdkd の実装が呼ぶ API を列挙した（サービス単位のワイルドカードは使わない）。
  トピックへの publish と、ログの中身の読み取りは持たない
- Lambda のコードの置き場所（cdkd のアセットのバケット `cdkd-assets-<アカウント>-<リージョン>`）の読み書き。
  kakeibo・learning と共用で、キーは中身のハッシュなので名前では絞れない
- Cognito はユーザープールの設定だけ。ユーザーそのものの操作（`Admin*`、`ListUsers` など）は拒否する
- Route53 のレコードは `auth.sakekasu-builder.com` の配下だけ書ける
- 証明書は参照（`acm:DescribeCertificate`）だけ。作成はコンソールで行う
- Cloud Control API（`cloudformation:CreateResource` など）。cdkd はユーザープールのドメインやクライアントをこれで作る。
  Cloud Control は呼び出し元の権限で各サービスを呼ぶので、上で許した以上のことはできない。CloudFormation のスタック操作は許していない
- cdkd の状態バケットは kakeibo・learning と共用なので、書けるのは `cdkd/sakekasu-integrated-*` の下だけ
- リージョンは ap-northeast-1 と us-east-1 に限る

権限が足りなければ、デプロイの途中で `AccessDenied` で落ちる。そのときはエラーに出た操作を
`cdkd-deploy-stack.ts`（監視の分は `cdkd-monitoring-statements.ts`）に足す。

## ログイン画面の見た目

ログイン画面の色は、4 アプリと同じ共通テーマ（`theme/sakekasu-theme.css`）から合成のたびに作る
（`infra/lib/login-branding.ts`）。テーマの色を直せば、次のデプロイでログイン画面も変わる。

- ライト・ダークは利用者の OS の設定に合わせる（4 アプリの画面と同じ）
- Cognito の既定の背景の模様は出さず、テーマの地の色だけにする
- フォント・角丸・認証アプリの絵などの画像は Cognito の既定のまま
- 設定の形は Cognito の既定（`infra/__tests__/fixtures/cognito-default-branding-settings.json`、
  `describe-managed-login-branding-by-client --return-merged-resources` で取ったもの）と同じにしてあり、
  テストで確かめている。Cognito が項目を足したら、取り直して合わせる

## まだやっていないこと

- 各アプリの切り替え（旧ユーザープールからの移行と、データの sub の付け替え）
