# 共通ログイン（identity）

4 つのアプリ（reinvent、builder、kakeibo、learning）で共有するログイン。
コードは `infra/lib/identity-stack.ts`、アプリの登録は `infra/cdk.json` の `apps` にある。

## 作り

- ユーザープールは 1 つ。新規登録は受け付けず、ユーザーは管理者が CLI で作る
- TOTP の MFA を必須にする。パスワードは 16 文字以上（英大文字・英小文字・数字を含む）
- ログイン画面は Cognito のマネージドログインを `auth.sakekasu-builder.com` で出す
- 各アプリはアプリクライアントを 1 つずつ持ち、ログイン画面へリダイレクトする（認可コード + PKCE）
- ログイン画面のドメインにセッションが残るので、1 つのアプリでログインすれば、
  ほかのアプリは入力なしで入れる
- ユーザープールは消えない設定（RETAIN と削除保護）。作り直すと sub が変わり、
  各アプリのデータとのひも付けが切れる

## スタック

| スタック | リージョン | 作られる条件 | 中身 |
| --- | --- | --- | --- |
| `sakekasu-integrated-auth-dns` | ap-northeast-1 | context `authZone` | `auth.sakekasu-builder.com` のゾーン |
| `sakekasu-integrated-auth-cert` | us-east-1 | context `authHostedZoneId` | ログイン画面の証明書 |
| `sakekasu-integrated-identity` | ap-northeast-1 | いつも | ユーザープール、ドメイン、アプリクライアント |

スタックの間は参照でつながない。ゾーン ID と証明書の ARN は、出力を `cdk.json` に書いて渡す。

## 独自ドメインを有効にする順番

独自ドメインが無いあいだ、ログイン画面は `https://sakekasu-integrated.auth.ap-northeast-1.amazoncognito.com` で出る。

1. `authZone` が入った状態でデプロイする。`sakekasu-integrated-auth-dns` の出力 `NameServers` に NS が 4 つ出る
2. Organization の管理アカウントにある `sakekasu-builder.com` のゾーンに、
   `auth` の NS レコードとして 4 つを入れる（手作業）
3. 委任が効いたことを確かめる。`dig NS auth.sakekasu-builder.com +short` が同じ 4 つを返せばよい。
   ここを飛ばすと、次の手順で証明書の DNS 検証が通らず、デプロイが終わらない
4. `cdk.json` に `authHostedZoneId`（1 の出力 `HostedZoneId`）を書いてデプロイする。
   us-east-1 に証明書ができる
5. `cdk.json` に `authCertificateArn`（4 の出力 `CertificateArn`）を書いてデプロイする。
   ログイン画面が `https://auth.sakekasu-builder.com` に移る

Cognito の独自ドメインは、親のドメイン（`sakekasu-builder.com`）に A レコードがあることを求める。
いまは builder のサイトがあるので満たしている。

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

## まだやっていないこと

- デプロイのワークフロー（GitHub Actions のロールをどう作るかが決まっていない）
- ログイン画面のブランディング（共通テーマの藍と金に合わせる）。いまは Cognito の既定の見た目
- 各アプリの切り替え（旧ユーザープールからの移行と、データの sub の付け替え）
