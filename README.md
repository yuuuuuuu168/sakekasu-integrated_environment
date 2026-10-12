# sakekasu-integrated_environment

個人で作っている 4 つの Web アプリ（sakekasu-reinvent、sakekasu-builder、sakekasu-kakeibo、
sakekasu-learning）が共通で使う基盤。アプリごとに別々だったものを、ここに 1 つだけ置く。

| 基盤 | 説明 |
| --- | --- |
| 共通ログイン（identity） | 4 アプリで共有する Cognito のユーザープールとログイン画面。[docs/identity.md](docs/identity.md) |
| 共通の監視と Slack 通知 | アラートの Slack 通知と DevOps Agent への自動調査の依頼、AWS Health、サイトの死活監視。各アプリのアラームの送り方も。[docs/monitoring.md](docs/monitoring.md) |
| apex の入口と転送 | `sakekasu-builder.com` と www。トップは 4 アプリへの入口のページ、ほかのパスは builder の画面（`sake.`）へ 301 で転送する CloudFront。[docs/apex-redirect.md](docs/apex-redirect.md) |

共通テーマ（`theme/`）は sakekasu-template から同期で配られる。このリポジトリで書き換えない。

## 構成

| パス | 中身 |
| --- | --- |
| `infra/` | AWS の構成（CDK、TypeScript）。main へのマージで cdkd がデプロイする |
| `docs/` | 基盤ごとの説明と手順 |
| `theme/` | 共通テーマ（sakekasu-template から同期） |
| `scripts/`、`.claude/` | Claude Code での開発用の設定（sakekasu-template から同期） |

デプロイ先は 4 アプリと同じアカウント（ap-northeast-1）。スタック名は `sakekasu-integrated-*`。

公開リポジトリなので、AWS アカウント ID はリポジトリに書かない。

| 使う場所 | 渡し方 |
| --- | --- |
| deploy ワークフローのロール ARN | リポジトリの Actions secrets `AWS_ACCOUNT_ID` |
| CDK（証明書の ARN を組み立てる） | 環境変数 `CDK_DEFAULT_ACCOUNT`（認証情報付きなら CDK が自動で入れる）。`cdk.json` には証明書の ID だけを置く |
| クラウドセッションの verify プロファイル | クラウド環境の Environment variables `SSO_ACCOUNT_ID` |

`infra/__tests__/no-account-ids.test.ts` が、許可したダミー以外の 12 桁の数字を見張る。

## 手元で確かめる

```sh
cd infra
npm ci
npx tsc --noEmit
npm test
CDK_DEFAULT_ACCOUNT=000000000000 npx cdk synth -q
```

`vitest` 4 系への更新を npm 10 で入れようとすると、ピア依存の解決で
`Cannot read properties of null (reading 'edgesOut')` が出て止まる。
lock を作り直すときは `npx npm@11 install` を使う（`npm ci` は npm 10 のままで通る）。

## 開発環境

Claude Code on the web で開発している。フック、AWS の読み取り専用ログイン、PR の watch、
テンプレートの同期の仕組みは [docs/claude-code-web.md](docs/claude-code-web.md) にある。
