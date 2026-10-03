# CLAUDE.md

## このリポジトリ

4 つのアプリ（sakekasu-reinvent、sakekasu-builder、sakekasu-kakeibo、sakekasu-learning）の共通基盤。
共通ログイン（Cognito）と、共通の監視・Slack 通知を置く。構成は [README.md](README.md)、
共通ログインの作りと手順は [docs/identity.md](docs/identity.md) にある。

```sh
(cd infra && npx tsc --noEmit && npm test)
(cd infra && CDK_DEFAULT_ACCOUNT=000000000000 npx cdk synth -q)
```

- デプロイとユーザーの作成は変更操作なので、このセッションからは行わない
- スタックの間は参照でつながない。ゾーン ID や証明書の ARN は `infra/cdk.json` の context で渡す
  （`crossRegionReferences` を使わない）
- ユーザープールは作り直さない。作り直すと sub が変わり、4 アプリのデータとのひも付けが切れる
- `theme/` と `scripts/` のフック類は sakekasu-template から同期される。直すときはテンプレート側を直す

## Git / ブランチ運用

- 機能開発は必ず feature ブランチを作成してから作業する
- ブランチに初回 push したら、必ず PR も作成する（push だけで終わらせない）
- PR のレビュー・マージは人間様が行う。余は PR 作成まで

### PR を作ったら watch する

PR を作成したら、ユーザーの指示を待たずにそのまま `subscribe_pr_activity` を呼び、
その PR の CI とレビューコメントを watch する。毎回「watch して」と言わせない。

- watch を始めたら、PR の URL とあわせて一行で報告する
- CI が落ちたら原因を調べて直し、同じブランチに push する。落ちた理由が自分の変更と
  無関係（base ブランチが赤い等）なら、その旨を PR に一度だけ書く
- レビューコメントは対応するか、対応しない理由を返す。黙って終わらせない
- watch はマージまたはクローズまで続ける。止めるのはユーザーに言われたときだけ

PR 作成の直後には [scripts/pr-watch-reminder.mjs](scripts/pr-watch-reminder.mjs)（`PostToolUse`
フック）が PR 番号つきで watch を促す。長いセッションでこの節が押し流されても効く。

## 応答の言語

応答は日本語で書く。[scripts/japanese-guard/](scripts/japanese-guard/)（`Stop` フック）が
ターンの最終回答を検査し、英語主体なら日本語で書き直させる。コードブロック・インラインコード・
URL は数えないので、英語のコマンドや英文の下書きはコードブロックに入れて見せる。

## AWS確認作業の認証フロー

AWS環境の確認が必要になったら、ユーザーの指示を待たずに次を実行する。

```sh
bash scripts/aws-sso-login.sh
```

AWS CLI v2 の導入、読み取り専用プロファイルの配置、SSO ログインの開始までをこれ一つで行う。
認証済みなら何もせず終わる。出力された確認URLとコードは、次のツールを呼ぶ前にそのまま
ユーザーへの返答として提示してターンを終え、承認したと言われてから
`bash scripts/aws-sso-login.sh --wait` で完了を確かめる。ツール呼び出しの合間に書いた文は
ユーザーの画面に出ないことがあり、URL を渡せないまま待ち時間だけが過ぎる。
以降のAWS CLI操作には必ず次のどれかのプロファイルを付ける。1回の承認で全部に入れる。

| プロファイル | アカウント | 使いどころ |
| --- | --- | --- |
| `verify` | Web アプリのデプロイ先 | アプリのログ・メトリクス・リソースの確認 |
| `verify-org` | Organization の管理アカウント | 組織・請求・Identity Center の確認 |
| `verify-ops` | 運用ツール用 | Security Agent / DevOps Agent の確認 |

接続先のアカウントなどは [scripts/aws-verify.conf](scripts/aws-verify.conf) にある。
値が欠けていると「未設定」で止まるので、その場合はユーザーに訊く。

セッション開始の時点でログインまで済ませたい場合は、クラウド環境の Environment
variables に `SAKEKASU_AWS_LOGIN=1` を設定する。

このプロファイルは読み取り専用（Permission Set `AgentVerifyAccess`）。create / update / delete / put 系の
変更操作は実行しない。変更操作は [scripts/deny-aws-writes.sh](scripts/deny-aws-writes.sh)（`PreToolUse`
フック）も止める。認証エラーに見える失敗が出た場合、まずクラウド環境のネットワーク設定で
`awsapps.com` と `*.amazonaws.com` への到達が許可されているかを疑う。

なお `aws-sso-login.sh` と `setup-aws-profile.sh` は `~/.aws/config` を上書きするため、
クラウドセッション（`CLAUDE_CODE_REMOTE=true`）でのみ動作する。ローカルでは何もせず終了する。
