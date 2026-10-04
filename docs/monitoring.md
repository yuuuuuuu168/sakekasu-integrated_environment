# 共通の監視と Slack 通知

4 つのアプリ（builder、kakeibo、learning、reinvent）のアラートを、1 つの SNS トピックから
1 つの Slack チャンネル（builder と同じ）へ流す。コードは `infra/lib/monitoring-stack.ts`、
`infra/lib/health-global-stack.ts`、`infra/lambda/` にある。作りは sakekasu-builder の監視を写したもの。

## 役割の分け方

| だれが | 持つもの |
| --- | --- |
| 共通基盤（このリポジトリ） | 通知の経路（トピックと Slack 通知 Lambda）、AWS Health、全サイトの死活監視 |
| 各アプリ | 自分のアラーム（Lambda のエラー、API の 5xx など）。送り先を共通のトピックにする |

AWS Health はアカウント全体の話なので、共通基盤だけが持つ。builder にも Health のルール
（`dev-sakekasu-aws-health` と us-east-1 の `dev-sakekasu-aws-health-global`）があるが、
両方が動くと同じ通知が 2 通届く。こちらが動いたのを確かめてから builder 側を外す。

## 構成

```
 各アプリのアラーム ───────────────┐  (ALARM / OK)
 共通基盤のアラーム ───────────────┤
                                  ▼
 AWS Health (ap-northeast-1) ─▶ EventBridge ─▶ SNS: sakekasu-integrated-alerts ─▶ Lambda: sakekasu-integrated-slack-notifier ─▶ Slack
                                  ▲   ルール: sakekasu-integrated-aws-health                 │ Webhook URL は SSM から読む
 AWS Health (us-east-1) ─▶ EventBridge ─┘                                               └ /sakekasu-integrated/monitoring/slack-webhook-url
   グローバルサービス分      ルール: sakekasu-integrated-aws-health-global
   （IAM、CloudFront など）  ap-northeast-1 の default バスへ転送

 EventBridge (5 分ごと) ─▶ Lambda: sakekasu-integrated-health-check ─▶ メトリクス sakekasu-integrated-monitoring/HealthCheckFailed
                             各サイトを叩く                          └▶ アラーム sakekasu-integrated-health-check-<名前>（5 分 × 2 回）
```

| スタック | リージョン | 中身 |
| --- | --- | --- |
| `sakekasu-integrated-monitoring` | ap-northeast-1 | トピック、Slack 通知、AWS Health のルール、外形監視、監視の監視 |
| `sakekasu-integrated-health-global` | us-east-1 | グローバルの AWS Health を ap-northeast-1 の default バスへ転送するルールとロール |

スタックの間は参照でつながない。転送先のバスの ARN は、アカウントとリージョンから組み立てる。

### 共通基盤が持つアラーム

| アラーム | 鳴る条件 |
| --- | --- |
| `sakekasu-integrated-health-check-<名前>` | 外形監視で期待した応答が 5 分 × 2 回続けて返らない |
| `sakekasu-integrated-slack-notifier-failure` | Slack への送信に失敗した（Webhook の未登録・失効など） |
| `sakekasu-integrated-watcher-failure-health-check` | 外形監視の Lambda がエラーで落ちた（1 時間に 1 回以上） |
| `sakekasu-integrated-watcher-silent-health-check` | 外形監視が 1 時間 1 回も動いていない（スケジュールの停止など） |

どれも ALARM と OK の両方を通知する。

#### 監視の監視が作成直後に一度鳴る

外形監視の Lambda と `sakekasu-integrated-watcher-silent-health-check` を同時に作ると（初回のデプロイや、
Lambda ごと作り直したとき）、最初の実行より先に最初の評価が来て「直近 1 時間の記録なし」で一度 ALARM になり、
実行されると数分で OK に戻る。これは直さずに受け入れている。作った直後は本当に 1 回も動いていないので、
指標だけでは「作ったばかり」と「止まった」を見分けられない。

- 評価を M of N にしても、作成直後は全期間が欠損なので鳴る。止まってから鳴るまでが延びるだけ
- `FILL(m, 0)` の式と `NOT_BREACHING` の組み合わせは、評価範囲にデータが 1 点も無くなると欠損に戻り、
  止まりっぱなしなのに OK（誤った「復旧」）になる
- `MISSING` は全部欠損だと INSUFFICIENT_DATA になり、止まっても鳴らない

アラームだけを作り直したときは、直近 1 時間の記録があるので鳴らない。

#### OK の通知に出る説明

アラームの説明（`alarmDescription`）は「鳴ったときに何が起きているか」の文で書く。状態によらず同じ説明が届くので、
Slack 通知では ALARM のときだけ「内容」として出し、OK と INSUFFICIENT_DATA のときは
「このアラームが見ているもの」として「次の状態になると鳴ります（今は解消しています）」の前置きを付けて出す。

## Slack の Webhook URL を登録する（最初に一度だけ）

Webhook URL はリポジトリに置けないので、SSM の SecureString に手で入れる。builder と同じチャンネルに
流すので、builder の `/dev-sakekasu/monitoring/slack-webhook-url` と同じ URL でよい。
書き込みの権限がある認証情報で、Mac から打つ（Claude Code のセッションの `verify` プロファイルは読み取り専用）。

```sh
aws ssm put-parameter \
  --region ap-northeast-1 \
  --name /sakekasu-integrated/monitoring/slack-webhook-url \
  --type SecureString \
  --value '<Webhook URL>'
```

キーは AWS 管理キー（`aws/ssm`）のままでよい。Lambda には `ssm:GetParameter` だけを渡してあり、
`kms:Decrypt` は要らない（AWS 管理キーのキーポリシーが、同じアカウントの SSM 経由の利用を許している）。
カスタマー管理キーに変えるときは、Lambda のロールと境界（`infra/lib/role-boundary.ts`）に `kms:Decrypt` を足す。

登録する前にデプロイしても壊れはしないが、通知が届くたびに Slack 通知 Lambda が落ちる。
先に登録しておく。URL を差し替えたときは、Lambda が値を覚えているので、しばらく前の URL に送り続ける
（実行環境が入れ替わるまで。気になるなら関数の設定を何か変えて入れ替える）。

## 各アプリからアラームを送る

トピックは固定名 `sakekasu-integrated-alerts`。ARN はアカウント ID から組み立てる（スタックの出力を
参照しない。参照でつなぐと、こちらのスタックを作り直せなくなる）。

```
arn:aws:sns:ap-northeast-1:<アカウント ID>:sakekasu-integrated-alerts
```

約束は 3 つ。

1. **ALARM と OK の両方を送る。** 復旧の通知が無いと、直ったかどうかが Slack だけでは分からない
2. **アラーム名をアプリの接頭辞で始める。** Slack の見出しに出すアプリ名は、アラーム名の接頭辞から引いている
   （`infra/lambda/slack-notifier/app-label.ts`）。当たらないと「不明なアプリ」と出る
3. **アラームは ap-northeast-1 に置く。** トピックがあるリージョン。us-east-1 のアラーム（CloudFront の指標など）
   から送れるかは確かめていない

| アプリ | アラーム名の接頭辞 | 例 |
| --- | --- | --- |
| builder | `dev-sakekasu-`（`staging-`、`prod-` も） | `dev-sakekasu-ocr-errors` |
| kakeibo | `sakekasu-kakeibo-` | `sakekasu-kakeibo-prod-api-errors` |
| learning | `dev-sakekasu-learning-`、`sakekasu-learning-` | `dev-sakekasu-learning-api-errors` |
| reinvent | `ReinventPlanner` | `ReinventPlanner-api-errors` |
| 共通基盤 | `sakekasu-integrated-` | `sakekasu-integrated-health-check-auth` |

照合は長い接頭辞から順に行う（`dev-sakekasu-learning-` は `dev-sakekasu-` より先に当たる）。
アプリを足したら、`app-label.ts` とこの表に足す。

### treatMissingData の考え方

データが無い期間を異常とみなすかどうか。CDK の既定は `MISSING` だが、ほとんどの場合は明示する。

| 指標の性質 | 指定 | 理由 |
| --- | --- | --- |
| エラー数、5xx の数など（起きたときだけ値が出る） | `NOT_BREACHING` | 呼び出しが無い夜中に「データ不足」で鳴らさない |
| 「動いたか」を見る指標（Invocations が 0 なら異常、など） | `BREACHING` | 止まると値そのものが出なくなる。欠損＝止まっている |
| たまにしか計測しないもの（6 時間ごとのカナリアなど） | `MISSING` | 次の計測までの空白で「復旧した」と誤って OK を送らない |

### TypeScript の CDK（builder、kakeibo、learning）

```ts
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

// 共通基盤のトピック。名前から ARN を組み立てる（スタックの出力は参照しない）
const alertTopic = sns.Topic.fromTopicArn(
  this,
  'SharedAlertTopic',
  `arn:aws:sns:ap-northeast-1:${cdk.Stack.of(this).account}:sakekasu-integrated-alerts`,
);

const alarm = new cloudwatch.Alarm(this, 'ApiErrors', {
  // アプリの接頭辞で始める（Slack に「kakeibo」と出る）
  alarmName: `sakekasu-kakeibo-${envName}-api-errors`,
  alarmDescription: 'API の Lambda がエラーを返しています',
  metric: apiFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
alarm.addAlarmAction(new actions.SnsAction(alertTopic));
alarm.addOkAction(new actions.SnsAction(alertTopic));
```

`fromTopicArn` で取り込んだトピックにはトピックポリシーを足せない（足しても何も起きない）。
CloudWatch からの publish はこちらのトピックポリシーで許してあるので、アプリ側で権限を足す必要は無い。
アプリの cdkd 用ロールに要るのは `cloudwatch:PutMetricAlarm` などアラームの操作だけで、`sns:*` は要らない。

### reinvent（.mjs）

```js
import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

const alertTopic = sns.Topic.fromTopicArn(
  this,
  'SharedAlertTopic',
  `arn:aws:sns:ap-northeast-1:${Stack.of(this).account}:sakekasu-integrated-alerts`,
);

const alarm = new cloudwatch.Alarm(this, 'ApiErrors', {
  // ReinventPlanner で始める（Slack に「reinvent」と出る）
  alarmName: 'ReinventPlanner-api-errors',
  alarmDescription: 'API の Lambda がエラーを返しています',
  metric: apiFunction.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
  threshold: 1,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
alarm.addAlarmAction(new actions.SnsAction(alertTopic));
alarm.addOkAction(new actions.SnsAction(alertTopic));
```

### 届いているかを確かめる

アラームの「状態」ではなく「アクションの履歴」を見る。状態は正しく遷移するので、
トピックポリシーで拒否されていても `describe-alarms` では気づけない（builder ではこれで 9 日間無音になった）。

```sh
aws cloudwatch describe-alarm-history --alarm-name <アラーム名> \
  --history-item-type Action --query 'AlarmHistoryItems[].[Timestamp,HistorySummary]'
```

`Failed to execute action` が出ていれば拒否されている。経路を試すなら、書き込みの権限がある認証情報で
`aws cloudwatch set-alarm-state --alarm-name <名前> --state-value ALARM --state-reason test` を打つと、
実際に Slack に届く（次の評価で元の状態に戻り、OK も届く）。

## 外形監視の対象を足す

`infra/cdk.json` の context `healthChecks` に足す。合成のときに `infra/lib/health-checks.ts` の
`parseHealthChecks` が形を確かめ、おかしければ合成が止まる。

```json
{ "name": "newapp", "url": "https://newapp.sakekasu-builder.com/", "expectStatus": [200] }
```

| 項目 | 中身 |
| --- | --- |
| `name` | 英小文字で始まる英小文字・数字・ハイフン（40 文字まで）。アラーム名 `sakekasu-integrated-health-check-<name>` とメトリクスの次元に入る |
| `url` | https だけ。認証情報と `#` は書けない |
| `method` | `GET`（既定）か `HEAD` |
| `expectStatus` | 正常とみなすステータス。既定は `[200]`。リダイレクトは追いかけ、最後の応答で判定する |

1 つ足すと、アラームが 1 つとカスタムメトリクスが 2 つ増える（下の費用）。

### 共通ログインで何を叩いているか

2 つ見ている。

- `auth`: ログイン画面 `https://auth.sakekasu-builder.com/login?client_id=<reinvent のクライアント ID>&response_type=code&redirect_uri=<reinvent の戻り先>`。
  利用者が実際に通る独自ドメイン（裏の CloudFront と証明書）とマネージドログインが生きていれば、
  ログイン画面の HTML が 200 で返る。引数の無い `/oauth2/authorize` などはエラー画面へのリダイレクトになり、
  応答の形が Cognito の都合で変わりうるので使わない。クライアント ID はブラウザに配る値で、秘密ではない
- `auth-issuer`: 発行者の OIDC 設定 `https://cognito-idp.ap-northeast-1.amazonaws.com/<プール ID>/.well-known/openid-configuration`。
  各アプリのバックエンドが JWT の検証に使う公開鍵の在りかで、ユーザープールがあれば必ず 200 の JSON を返す。
  独自ドメインの不調と、ユーザープールそのものの不調を見分けられる

`auth-issuer` は 2026-10-03 に 200 を確かめた。`auth` はこのリポジトリの開発環境から独自ドメインへ
つなげなかったので確かめていない。初めてデプロイする前に、手元で 200 が返ることを確かめておく。

```sh
curl -s -o /dev/null -w '%{http_code}\n' -L \
  'https://auth.sakekasu-builder.com/login?client_id=7thbqs1omkqdgo6k922sqhefdi&response_type=code&redirect_uri=https%3A%2F%2Freinvent.sakekasu-builder.com%2F'
```

## デプロイと権限

main へのマージで `.github/workflows/deploy.yml` が cdkd で出す。cdkd 用ロール
（`sakekasu-integrated-github-actions-cdkd`）の権限は、同じワークフローが CloudFormation で毎回入れ直すので、
権限を足す PR もマージだけで反映される。権限の中身は `infra/lib/cdkd-monitoring-statements.ts` と
[identity.md](identity.md) の「cdkd 用ロールの権限」にある。

監視の Lambda と転送ルールのロールは、cdkd 用ロールが作る。作れるのは名前が `sakekasu-integrated-app-` で始まり、
Permissions Boundary `sakekasu-integrated-role-boundary` が付いたロールだけ。境界の中身は
`infra/lib/role-boundary.ts` にあり、監視の Lambda と転送に要る操作（ログの書き込み、SSM の読み取り、
メトリクスの書き込み、SNS への publish、イベントの転送、X-Ray）しか入っていない。
Lambda に新しい操作を足すときは、境界にも足さないと実行時に AccessDenied になる。

### cdkd のアセットの置き場所

Lambda のコードは、cdkd の置き場所 `cdkd-assets-<アカウント>-<リージョン>` に上がる。cdkd は状態バケットの
`cdkd-bootstrap/<リージョン>.json`（`cdkd bootstrap` が書く印）を見て置き場所を決める。同じアカウントの
kakeibo の deploy ワークフローが ap-northeast-1 と us-east-1 の両方で `cdkd bootstrap` を済ませているはずで、
deploy ワークフローは cdkd を動かす前に印があるかを確かめる。無いと言われたら、管理者の権限で一度だけ打つ。

```sh
cd infra
npx cdkd bootstrap --region ap-northeast-1
npx cdkd bootstrap --region us-east-1
```

cdkd 用ロールに bootstrap の権限は持たせていない。

## 費用の目安

ap-northeast-1 の料金（2026-10 時点）で月 5 ドル前後。

| もの | 数 | 月額 |
| --- | --- | --- |
| CloudWatch アラーム（標準） | 9（外形監視 6、Slack 通知 1、監視の監視 2） | 約 0.9 ドル |
| カスタムメトリクス | 12（外形監視の対象ごとに失敗と応答時間） | 約 3.6 ドル（アカウントの無料枠 10 個が残っていれば減る） |
| PutMetricData | 月 8,640 回 | 約 0.1 ドル |
| Lambda | 外形監視 月 8,640 回（数秒ずつ）、Slack 通知は届いた分だけ | 無料枠に収まる |
| SNS、EventBridge、AWS Health | Lambda への配信、ルール、Health のイベント | 0 |
| CloudWatch Logs | 30 日で消える。量は小さい | ほぼ 0 |

いちばん大きいのはカスタムメトリクス。応答時間（`HealthCheckLatency`）はアラームに使っていないので、
費用を詰めたいときは外せば半分になる。
