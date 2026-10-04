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

親ゾーン `sakekasu-builder.com` は Organization の管理アカウントにあり、
cdkd の権限は届かない。証明書の検証レコードと、apex・www のレコードは人が入れる。

## 手順

### 1. CloudFront を作る

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

続けて行う。**DNS を先に替えてから、CloudFront にドメインを付ける。** 逆にすると、CloudFront が
「DNS が別の CloudFront（Amplify）を向いている」として付け替えを断る（2026-10-04 に実際に断られた）。

```
One or more aliases specified for the distribution includes an incorrectly configured DNS record
that points to another CloudFront distribution.
```

1. Amplify のコンソールで、アプリの「カスタムドメイン」から `sakekasu-builder.com` を外す
2. 管理アカウントの親ゾーンで、apex と www をこの CloudFront に向ける。A と AAAA のエイリアスで、
   向け先は `DistributionDomainName`、エイリアスのゾーン ID は CloudFront の固定値 `Z2FDTNDATAQYW2`。
   www が CNAME のときは、同じ変更の中で CNAME を DELETE してから A / AAAA を CREATE する
   （同じ名前に CNAME と A は並べられない）
3. `infra/cdk.json` に `"apexCertificateArn": "<手順 2 の ARN>"` を足す PR をマージする。
   deploy が CloudFront に apex と www を付ける。上のエラーが出たら DNS がまだ古い。www の CNAME の
   TTL（300 秒）が切れるまで待って deploy を再実行する。`CNAMEAlreadyExists` なら Amplify 側の
   解除が届いていないので、同じく数分おいて再実行する
4. 確かめる

```sh
curl -sI https://sakekasu-builder.com/records | grep -iE '^(HTTP|location)'
curl -sI https://www.sakekasu-builder.com/ | grep -iE '^(HTTP|location)'
```

### 5. Amplify アプリを消す

転送が効いていることを確かめてから、Amplify のコンソールでアプリを削除する。

あわせて片付ける。

- ログインの戻り先（このリポジトリの `infra/cdk.json` の apps）から apex と www を外す。
  apex に来たアクセスは転送されるので、ログイン後に apex へ戻ることはもう無い
- sakekasu-builder 側（同リポジトリの docs/sake-subdomain.md の「片付け」）

## 実施の記録（2026-10-04）

| 項目 | 値 |
| --- | --- |
| CloudFront | `E3V1KUNQL6W5RN`（`d1tb8xjqesgxv0.cloudfront.net`） |
| 証明書 | `arn:aws:acm:us-east-1:232791540685:certificate/b40b5b6b-5b1f-47aa-8f43-d7604696a25a`（apex と www の 2 つの名前を 1 枚に入れる。CloudFront に付けられる証明書は 1 枚だけ） |
| 親ゾーン | `Z0378029DKDVAJ2VE475`（管理アカウント） |
| 付け替える前 | apex は A（エイリアス）、www は CNAME。どちらも Amplify の `d158s516cgxf7d.cloudfront.net` |
| 触らないもの | apex の MX（Google のメール）と TXT（Google のサイト確認）、証明書の検証用 CNAME 2 つ（自動更新に要る） |

Amplify アプリは同じ日に削除した。builder は Amplify のバックエンドを使っていない
（AppSync・DynamoDB・Cognito・S3 はすべて CDK）ので、消えたのはホスティングだけ。

## 戻すとき

Amplify アプリは消したので、Amplify には戻せない。転送をやめて別のものを apex に置くときは、
このスタックの関数を書き換えるか、オリジンを差し替える。apex の A レコードは、共通ログインのために
何かを指したまま残す（[identity.md](identity.md)）。
