# sakekasu-template

クラウドセッション（Claude Code on the web）で開発する Web アプリ用のテンプレート。
新しいアプリのリポジトリをここから作ると、Claude Code の設定一式が最初から入った状態で始まる。

## 入っているもの

| 仕組み | ファイル | 何をするか |
| --- | --- | --- |
| セッション開始時のセットアップ | `scripts/cloud-setup.sh`（SessionStart） | `npm ci`（ロックファイルが変わったときだけ）と、運用方針の読み込み |
| AWS の読み取り専用ログイン | `scripts/aws-sso-login.sh`、`scripts/setup-aws-profile.sh`、`scripts/aws-verify.conf` | AWS CLI v2 の導入（署名検証つき）、`verify`（アプリ）・`verify-org`（管理）・`verify-ops`（運用ツール）プロファイルの配置、SSO デバイスコードログイン（1回の承認で全アカウント） |
| AWS 変更操作のガード | `scripts/deny-aws-writes.sh`（PreToolUse） | クラウドセッションで、読み取り以外の AWS CLI 操作を拒否する |
| PR の watch の念押し | `scripts/pr-watch-reminder.mjs`（PostToolUse） | PR を作った直後に、その PR を watch するよう促す |
| 日本語ガード | `scripts/japanese-guard/`（Stop） | 最終回答が英語主体なら日本語で書き直させる |
| MCP | `.mcp.json` | AWS Knowledge、AWS Documentation、Tavily（Web 検索） |
| 運用ルール | `CLAUDE.md` | ブランチ運用、PR の watch、応答言語、AWS の手順 |
| フックの CI | `.github/workflows/claude-hooks.yml` | 上のフックのテストを PR ごとに走らせる |
| 共通テーマ | `theme/sakekasu-theme.css`、`theme/sakekasu-theme.test.mjs` | 4 アプリで同じ色とフォントを使うための CSS 変数（`--sk-*`）。和風の藍と金、ライト/ダーク対応 |
| テンプレートの同期 | `.claude/skills/template-sync/`、`scripts/template-sync.mjs`、`.template-sync.json` | `/template-sync` で、テンプレートの変更を取り込んだ PR を作る |

仕組みの詳しい説明は [docs/claude-code-web.md](docs/claude-code-web.md) にある。

## 新しいアプリを作るとき

1. GitHub でこのリポジトリの **Use this template** → **Create a new repository** を選ぶ
2. Claude の GitHub App が新しいリポジトリにアクセスできることを確かめる
   （App を「Only select repositories」で入れている場合は、GitHub の Settings → Applications → Claude で追加する）
3. `scripts/cloud-setup.sh` の `NPM_DIRS` に、`npm ci` が要るディレクトリを並べる（既定は `.` と `infra`）
4. `CLAUDE.md` の先頭にアプリの概要を書き、この README をアプリの README に書き換える

AWS の接続先（`scripts/aws-verify.conf`）は sakekasu-builder と同じ3アカウント
（アプリのデプロイ先・Organization の管理アカウント・運用ツール用）が入っているので、そのまま使える。
アプリを別のアカウントに載せるときだけ `SSO_ACCOUNT_ID` を書き換える。

最初のセッションでは `.mcp.json` の MCP サーバーを有効にするか訊かれるので、承認する。

## クラウド環境の設定（最初の一度だけ）

クラウド環境（セッションのタイトルバーの環境メニュー → Edit）の設定は、その環境を使う
すべてのリポジトリに共通でかかる。アプリごとに設定し直す必要はない。

- **Network access**：`awsapps.com` と `*.amazonaws.com`、`mcp.tavily.com`、`knowledge-mcp.global.api.aws` への到達を許可する
- **Environment variables**：
  - `TAVILY_API_KEY`：Tavily の Web 検索を使うなら
  - `SAKEKASU_AWS_LOGIN=1`：毎セッション開始時に AWS の SSO ログインまで進めたいなら
- **Setup script**：空でよい（依存の導入はリポジトリ側の SessionStart フックが行う）

## 前提

- AWS 側に読み取り専用の Permission Set `AgentVerifyAccess` があり、`aws-verify.conf` に並べた各アカウントに割り当ててあること。
  考え方は sakekasu-builder の `docs/agent-verify-permission-set.md` を参照
- 日本語ガードは Python 3、そのほかのフックは Node.js で動く。どちらもクラウドVMには入っている

## 共通テーマ

`theme/sakekasu-theme.css` は sakekasu-builder の和風の配色（藍 `#1B365D` と金 `#C5A572`）を
CSS 変数にしたもの。どのアプリにも同期で同じ中身が入るので、アプリ側では書き換えない。

- アプリの CSS の先頭で読み込み、色とフォントは `--sk-*` の変数だけを参照する。
  Tailwind v4 のアプリは `@import 'tailwindcss';` の後に読み込み、`@theme inline` で
  `--sk-*` を自分の色名に割り当てる
- 同じオリジンから配るので、各アプリの CSP（`style-src 'self'`）は変えなくてよい
- ライト/ダークは OS の設定に従う。アプリで切り替えるときは `<html>` に
  `data-theme="light"` か `data-theme="dark"` を付ける
- 色を変えたら `node --test theme/sakekasu-theme.test.mjs` を通す。ダークの値を書いた 2 か所の一致と、
  文字と地のコントラスト（WCAG AA）を確かめる。CI（`claude-hooks.yml`）でも走る

## テンプレートを直したとき（同期）

テンプレートは作った時点のコピーなので、ここを直しただけでは既存のアプリに反映されない。
各アプリのセッションで `/template-sync`（または「テンプレートから同期して」）と頼むと、
前回の同期以降の変更を取り込んだ PR ができる。

- どのファイルをどう扱うかは [.template-sync.json](.template-sync.json) が決める
  - `managed`：テンプレートと同じ中身を保つ。同期でそのまま上書きする（フックのスクリプト、CI など）
  - `merged`：アプリごとの内容と混ぜる。前回の同期以降の差分を出し、Claude が手で当てる（settings.json、CLAUDE.md など）
- 各アプリの `.template-sync.json` は、取り込んだテンプレートのコミット（`syncedCommit`）と、
  そのアプリで上書きしたくない managed（`exclude`）だけを持つ
- 手順は [.claude/skills/template-sync/SKILL.md](.claude/skills/template-sync/SKILL.md)、
  処理は [scripts/template-sync.mjs](scripts/template-sync.mjs) にある

テンプレートから新しく作ったアプリは、この仕組みごとコピーされる。最初の同期で
`.template-sync.json` の `syncedCommit` が入るので、それまでは差分が全体の突き合わせになる。
