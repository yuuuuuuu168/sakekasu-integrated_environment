# apex（sakekasu-builder.com）と www の転送

builder を `sake.sakekasu-builder.com` へ移した（sakekasu-builder の docs/sake-subdomain.md）。
apex と www は、これまで builder を配っていた Amplify Hosting に付いたままになっている。
ここを転送専用の CloudFront（`sakekasu-integrated-apex-redirect`、us-east-1）に付け替え、
Amplify アプリを消す。

## 作り

- CloudFront Functions がビューアーリクエストで 301 を返すだけ。パスとクエリは保つ
  （`https://sakekasu-builder.com/records?x=1` → `https://sake.sakekasu-builder.com/records?x=1`）
- オリジンには届かない。CloudFront がオリジンを 1 つ求めるので、転送先を置いてある
- HSTS（`max-age=31536000; includeSubDomains`）を付ける。Amplify が apex に出していたもの
- 置き場所が builder ではなくこのリポジトリなのは、apex が 4 アプリ共通のドメインになるため。
  入口のページに変えるときもここで済む
- apex の A レコードは消さない。共通ログインの独自ドメインが、親のドメインに A レコードが
  あることを求める（[identity.md](identity.md)）。この CloudFront に向けておけば満たし続ける

親ゾーン `sakekasu-builder.com` は Organization の管理アカウント（<管理アカウント ID>）にあり、
cdkd の権限は届かない。証明書の検証レコードと、apex・www のレコードは人が入れる。

## 手順

### 1. CloudFront を作る（この PR）

マージすると、deploy ワークフローが関数とディストリビューションを作る。まだ独自ドメインは
付けない。apex と www は Amplify の CloudFront に付いたままで、同じドメインは 2 つの
CloudFront に同時に付けられないため。

既定のドメインで転送を確かめる。ドメインは deploy のログの `DistributionDomainName` にある。

```sh
curl -sI https://<DistributionDomainName>/records | grep -iE '^(HTTP|location)'
```

`301` と `location: https://sake.sakekasu-builder.com/records` が返ればよい。

### 2. 証明書を作る（人の作業）

アプリのアカウント（232791540685）のコンソールで、リージョンを us-east-1 にして ACM を開く。

1. 「証明書をリクエスト」→「パブリック証明書」
2. ドメイン名に `sakekasu-builder.com` と `www.sakekasu-builder.com` の 2 つ。検証は DNS
3. 証明書の画面に出る検証用の CNAME（2 つ）を、管理アカウントの親ゾーンに入れる。
   「Route 53 でレコードを作成」は使えない（ゾーンが別のアカウントにあるため）
4. 「発行済み」になったら ARN を控える

### 3. いまのレコードを控える（人の作業、管理アカウント）

戻すときのために、apex と www のいまの中身を取っておく。

```sh
aws route53 list-resource-record-sets --profile yuuuuuuuki7749 \
  --hosted-zone-id Z0378029DKDVAJ2VE475 \
  --query "ResourceRecordSets[?Name=='sakekasu-builder.com.' || Name=='www.sakekasu-builder.com.']"
```

### 4. 付け替える（数分、apex が繋がらない時間がある）

続けて行う。

1. Amplify のコンソールで、アプリの「カスタムドメイン」から `sakekasu-builder.com` を外す
2. `infra/cdk.json` に `"apexCertificateArn": "<手順 2 の ARN>"` を足す PR をマージする。
   deploy が CloudFront に apex と www を付ける。`CNAMEAlreadyExists` で落ちたら、Amplify 側の
   解除が CloudFront に届いていない。数分おいて deploy を再実行する
3. 管理アカウントの親ゾーンで、apex と www をこの CloudFront に向ける。A と AAAA のエイリアスで、
   向け先は `DistributionDomainName`、エイリアスのゾーン ID は CloudFront の固定値 `Z2FDTNDATAQYW2`。
   www が CNAME のときは、同じ変更の中で CNAME を DELETE してから A / AAAA を CREATE する
   （同じ名前に CNAME と A は並べられない）
4. 確かめる

```sh
curl -sI https://sakekasu-builder.com/records | grep -iE '^(HTTP|location)'
curl -sI https://www.sakekasu-builder.com/ | grep -iE '^(HTTP|location)'
```

### 5. Amplify アプリを消す

転送が効いていることを確かめてから、Amplify のコンソールでアプリを削除する。

あわせて sakekasu-builder 側を片付ける（同リポジトリの docs/sake-subdomain.md の「片付け」）。

- ログインの戻り先（このリポジトリの `infra/cdk.json` の apps）から apex と www を外す
- builder の画像バケットの CORS から apex と `*.amplifyapp.com` を外す

## 戻すとき

手順 4 の後なら、Amplify にカスタムドメインを付け直し、手順 3 で控えたレコードに戻す。
CloudFront から apex と www を外すには、`apexCertificateArn` を cdk.json から消してデプロイする。
Amplify アプリを消した後は戻せないので、手順 5 は様子を見てから行う。
