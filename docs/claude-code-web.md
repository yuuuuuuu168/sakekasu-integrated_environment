# Claude Code on the web での開発

iPhone のブラウザ／Claude アプリからタスクを投げ、「タスク指示 → PR 確認 → マージ → 自動デプロイ」を Mac なしで完結させるための設定。

セッションは Anthropic 管理のクラウド VM で動き、完了するとブランチを push して PR を作る。マージ後のデプロイの仕組みはアプリごとに決める。

## 初回セットアップ（ブラウザで1回だけ）

1. [claude.ai/code](https://claude.ai/code) にアクセスし、GitHub App を連携する
2. リポジトリアクセスの注意: **App のインストール範囲 ＝ セッションのアクセス範囲ではない**。セッションは連携した GitHub アカウントが見えるリポジトリ全体にアクセスできる。絞りたい場合は GitHub 側でアカウント権限を制限する
3. 画面上部の雲アイコン → 「Add cloud environment」で環境を作る
   - **Network access**: まずはデフォルトの Trusted（GitHub / npm / PyPI / AWS SDK 系ドメインを許可済み）で開始。足りないドメインが出たら Custom に切り替えて追加する（「Also include default list of common package managers」は残す）
   - **Environment variables**: 現時点では不要（Tavily を使うなら `TAVILY_API_KEY`）。AWS の確認を毎セッションするなら `SAKEKASU_AWS_LOGIN=1` を入れると、セッション開始の時点で SSO ログインまで進む
   - **Setup script**: 空でよい。依存インストールはリポジトリ側の SessionStart フックで自動実行される（下記）

## 依存インストールの自動実行（リポジトリ側・設定済み）

- [.claude/settings.json](../.claude/settings.json) の SessionStart フックが、セッション開始・再開のたびに [scripts/cloud-setup.sh](../scripts/cloud-setup.sh) を実行する
- スクリプトは `NPM_DIRS` に並べたディレクトリ（既定は `.` と `infra`、`package-lock.json` が無いものは飛ばす）の `npm ci` を行う。インストール時に `package-lock.json` のハッシュを `node_modules/.package-lock.sha256` に控えておき、一致する（＝依存が変わっていない）ときだけスキップして高速起動する。ロックファイルだけ更新されたブランチでも古い依存のまま動くことはない
- 最後に運用方針（AWS 認証の取り方、PR の watch）を標準出力に出す。SessionStart フックの標準出力はそのままセッションの文脈に入るので、毎セッションの先頭に必ず載る。同じ内容は [CLAUDE.md](../CLAUDE.md) にも書いてあるが、そちらは長いセッションでは押し流されるため二重に置いている
- `$CLAUDE_CODE_REMOTE` がクラウド VM でだけ `true` になるため、ローカルの Claude Code セッションでは何もしない

## PR の watch（都度お願いしなくてよい）

- PR を作ったら指示を待たずに `subscribe_pr_activity` を呼ぶ、というのが [CLAUDE.md](../CLAUDE.md) の運用。watch しているセッションには CI の結果とレビューコメントが届き、赤ければ直して push する
- 念押しとして [scripts/pr-watch-reminder.mjs](../scripts/pr-watch-reminder.mjs)（`PostToolUse` フック）を置いている。PR 作成ツール（GitHub の MCP の `create_pull_request`）が成功した直後と、`gh pr create` を含む Bash の直後に発火し、`hookSpecificOutput.additionalContext` で PR 番号つきの指示を返す。`PostToolUse` は素の標準出力が Claude に届かない（デバッグログ行き）ので、JSON で返す必要がある
- 番号は MCP ツールの返り値から拾う。構造化されたオブジェクトのことも、JSON を丸ごと入れた文字列のこともあるため再帰で探し、`html_url` の `/pull/<番号>` を優先する。レビューや issue の入れ子にも `number` があるため
- `gh pr create` は作った PR の URL を標準出力に出すので、そこから owner / repo / 番号を拾う。Bash のフックは全コマンドで発火するので、行頭か区切りの直後に `gh pr create` があり、出力に PR の URL があるときだけ念押しを出す（`gh pr view` や `--help` では黙る）
- テストは `scripts/pr-watch-reminder.test.mjs`（`claude-hooks.yml` が走らせる）
- 判断材料を足すだけのフックなので、入力が壊れていても異常終了させない（拾えなければ番号なしの文言を返す）
- `.claude/settings.json` の `permissions.allow` に `mcp__claude-code-remote__subscribe_pr_activity` と `unsubscribe_pr_activity` を入れてあり、watch の開始と終了で承認プロンプトは出ない。watch のツールは github の MCP サーバーではなく、クラウドセッションの `claude-code-remote` が持っている

## MCP サーバー（.mcp.json）

リポジトリ直下の `.mcp.json` で、クラウドセッションに持ち込む MCP を定義している。**AWS 認証が必要な MCP（cloudwatch / awsiac / awspricing 等）は意図的に含めていない**（長期キーを VM に置かないため。それらは Mac 作業専用）。

| サーバー | 種別 | 外部に送られるもの |
|---|---|---|
| `aws-knowledge` | HTTP（AWS 公式） | 検索クエリが `knowledge-mcp.global.api.aws` に送られる。認証不要 |
| `tavily-remote-mcp` | HTTP（Tavily 社） | Web 検索クエリが `mcp.tavily.com` に送られる。`TAVILY_API_KEY`（環境変数）が必要 |
| `awslabs-aws-documentation-mcp-server` | stdio（uvx でローカル起動） | AWS ドキュメント取得のリクエストのみ。バージョンは供給網対策で `==X.Y.Z` に固定しており、更新は PR で明示的に上げる |

- プロジェクトスコープの MCP は**初回セッションで承認プロンプトが出る**（無断で有効化はされない）。承認すると以後有効
- 検索クエリは Claude が文脈から生成するため、機密にしたい値（アカウント ID 等）を検索させたくない場合はプロンプトで明示する
- `TAVILY_API_KEY` はローカルでは `~/.zshrc.local`、クラウドでは環境設定の Environment variables で渡す。**キー本体をリポジトリに置かない**

## AWS の確認作業（verify プロファイル）

- 入口は [scripts/aws-sso-login.sh](../scripts/aws-sso-login.sh) の一本。プロファイルの用意からログインの開始までをまとめてあり、AWS の確認が要るときに指示を待たず実行する。認証済みなら何もせず終わる。承認の完了は `--wait`、状態だけ見るなら `--status`
- デバイスコードフローの `aws sso login` は、URL とコードを出したあと承認されるまで前面で待ち続ける。Bash ツールから直に実行すると出力が返らず、肝心の URL とコードをユーザーに渡せないまま固まる（渡せないので承認もされない）。そのためスクリプトはログインを `setsid nohup` で背後に回し、ログに出た URL とコードだけを拾って先に返す。ログはコードが載るので `umask 077` で置く
- ログインまでセッション開始時に済ませたい場合は、環境設定の Environment variables に `SAKEKASU_AWS_LOGIN=1` を入れる。既定で走らせないのは、AWS を触らないセッションにまで AWS CLI の 70MB 超のダウンロードを負わせないため
- [scripts/setup-aws-profile.sh](../scripts/setup-aws-profile.sh) が `~/.aws/config` に `sso-session verify` と、それを共有する `verify`（アプリ）・`verify-org`（管理アカウント）・`verify-ops`（運用ツール用）の各プロファイルを書き出す。プロファイルとアカウントの対応は [scripts/aws-verify.conf](../scripts/aws-verify.conf) の `SSO_ACCOUNT_ID` と `SSO_EXTRA_PROFILES` で決める。認証は毎セッション `aws sso login --profile verify --use-device-code` で取得し、同じ SSO セッションのトークンで全プロファイルに入れる。長期キーは VM にもリポジトリにも置かない。呼ぶたびに `~/.aws/config` を書き直して控えを増やすため、`aws-sso-login.sh` は AWS CLI v2 が無いときと、`aws-verify.conf` の中身が書き出し済みの設定と違うときだけ呼ぶ
- クラウドのコンテナには AWS CLI が入っていないため、同じスクリプトが先に v2 を導入する（v2 が入っていれば飛ばす）。SSO のデバイスコードフローは v1 では動かないので、有無ではなくバージョンで判定している。SessionStart フックではなくこちらに置いたのは、AWS を触らないセッションにまで 70MB 超のダウンロードを負わせないため
- インストーラは実行前に PGP 署名を検証する。公開鍵は [scripts/aws-cli-public-key.asc](../scripts/aws-cli-public-key.asc) に同梱し、指紋 `FB5DB77FD5C118B80511ADA8A6310ACC4672475C` まで突き合わせる。配信元と同じホストから落とすハッシュでは配信側が乗っ取られたときに検証にならないため、ハッシュではなく署名を見る（AWS はこの zip に `.sha256` を公開しておらず、`.sig` だけを出している）。判定は `gpg` の終了コードではなく `--status-fd` の出力で行う。鍵が期限切れでも終了コードは 0 のままで `VALIDSIG` も出るため、期限切れ時に消える `GOODSIG` と併せて見る。鍵を差し替える PR は AWS の公式手順の記載と照らしてレビューする
- 参照する Permission Set は `AgentVerifyAccess`。作成手順と権限の考え方は sakekasu-builder の `docs/agent-verify-permission-set.md` にまとめてある。接続先のアカウントは [scripts/aws-verify.conf](../scripts/aws-verify.conf) で指定する
- このスクリプトも `$CLAUDE_CODE_REMOTE` を見てクラウド VM でだけ動く。ローカルの `~/.aws/config` を上書きしないため
- 変更操作は [scripts/deny-aws-writes.sh](../scripts/deny-aws-writes.sh)（`PreToolUse` フック）が止める。読み取り操作だけを通す許可リスト方式で、`get-` / `list-` / `describe-` などの接頭辞と、`sso login` / `logs tail` / `s3 ls` のような明示リストに載るものだけが通る。明示リストに足すときは、`ecs execute-command` のように名前が読み取りっぽくても実質が違うものがあるため、一つずつ実際の権限を確かめる。`invoke` や `assume-role` のように動詞が read でも write でもない操作を数え漏らさないため、拒否リストではなく許可リストにしている
- 名前が読み取りに見えても、資格情報を返す操作や IAM で認証されない操作は明示的に落とす。一覧は CLI 同梱の botocore モデルから機械的に出した
- このフックはうっかり変更操作を打つのを止める関門であって、権限の境界ではない。本当の境界は `AgentVerifyAccess` の IAM 側と、Identity Center の割り当てにある
- 追えない形は既知の限界としてテストに固定してある（別名で置いた実体、標準入力からコマンドを読むシェルの中身）。後者を一律に拒否すると、シェルに流し込む形のインストール手順まで止まるため、拒否はしていない（#46）
- 判定の本体は [scripts/deny-aws-writes-core.mjs](../scripts/deny-aws-writes-core.mjs)、テストは [scripts/deny-aws-writes.test.mjs](../scripts/deny-aws-writes.test.mjs) にある。`node --test scripts/deny-aws-writes.test.mjs` で走り、CI では `.github/workflows/claude-hooks.yml` が回す
- このフックも**クラウドでだけ判定する**。`permissions.deny` に書くとリポジトリ共有のためローカルの正当な管理作業（`sso-admin create-permission-set` など）まで止まり（sakekasu-builder で実際に一度それで詰まった）
- Network access は `awsapps.com` と `*.amazonaws.com` への到達が必要。認証エラーに見える失敗はまずここを疑う
- `.claude/settings.json` の `permissions.allow` には `aws sso login` / `aws sts get-caller-identity` / `bash scripts/aws-sso-login.sh` を入れてある。ログインのたびに承認プロンプトを挟まないためで、変更操作の関門は従来どおり `deny-aws-writes.sh` と IAM 側にある

## コスト・利用枠の注意

- Web 版の利用は契約の共有枠（5時間枠＋週次枠）を消費する。ローカルの Claude Code やチャットと合算される
- 残枠は `/usage` コマンドまたは Web／アプリの設定画面で確認する
- Extra Usage（従量課金）を有効化する場合は Spending cap の設定を必須とする

## 日本語ガード

- [scripts/japanese-guard/](../scripts/japanese-guard/)（`Stop` フック）が、ターンの最終回答が英語主体なら終了を止めて日本語で書き直させる。出どころと閾値は同ディレクトリの README にある
- 差し戻しは1ターンに1回だけ。コードブロック・インラインコード・URL は数えない
