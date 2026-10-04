# sakekasu-integrated_environment

個人で作っている 4 つの Web アプリ（sakekasu-reinvent、sakekasu-builder、sakekasu-kakeibo、
sakekasu-learning）が共通で使う基盤。アプリごとに別々だったものを、ここに 1 つだけ置く。

| 基盤 | 状態 | 説明 |
| --- | --- | --- |
| 共通ログイン（identity） | 作成中 | 4 アプリで共有する Cognito のユーザープールとログイン画面。[docs/identity.md](docs/identity.md) |
| 共通の監視と Slack 通知 | 作成中 | アラートの Slack 通知、AWS Health、サイトの死活監視。各アプリのアラームの送り方も。[docs/monitoring.md](docs/monitoring.md) |
| apex の転送 | 作成中 | `sakekasu-builder.com` と www を builder の画面（`sake.`）へ 301 で転送する CloudFront。[docs/apex-redirect.md](docs/apex-redirect.md) |

共通テーマ（`theme/`）は sakekasu-template から同期で配られる。このリポジトリで書き換えない。

## 構成

| パス | 中身 |
| --- | --- |
| `infra/` | AWS の構成（CDK、TypeScript）。main へのマージで cdkd がデプロイする |
| `docs/` | 基盤ごとの説明と手順 |
| `theme/` | 共通テーマ（sakekasu-template から同期） |
| `scripts/`、`.claude/` | Claude Code での開発用の設定（sakekasu-template から同期） |

デプロイ先は 4 アプリと同じアカウント（ap-northeast-1）。スタック名は `sakekasu-integrated-*`。

## 手元で確かめる

```sh
cd infra
npm ci
npx tsc --noEmit
npm test
CDK_DEFAULT_ACCOUNT=000000000000 npx cdk synth -q
```

### npm audit で残している警告

`infra/` の `npm audit` には、直せない high が 8 件残る（2026-10 時点）。

- `@go-to-k/cdkd` 配下の `braces` / `micromatch` / `fast-glob` / `cdk-local` /
  `@aws-cdk/toolkit-lib` / `@aws-cdk/cdk-assets-lib`。`braces` に修正版が無い
- `aws-cdk-lib` に同梱された `brace-expansion`。同梱なので overrides が効かない

どれもグロブを展開するときの DoS で、合成とデプロイのときにだけ動く。展開するのは
リポジトリに書いた自分たちのグロブで、外から入力が渡る経路は無いので実害は無い。
cdkd のバージョンを下げたり、cdkd 配下を overrides で差し替えたりはしない。
上流が直したら、cdkd と aws-cdk-lib を上げて消す。

なお、`vitest` 4 系への更新を npm 10 で入れようとすると、ピア依存の解決で
`Cannot read properties of null (reading 'edgesOut')` が出て止まる。
lock を作り直すときは `npx npm@11 install` を使う（`npm ci` は npm 10 のままで通る）。

## 開発環境

Claude Code on the web で開発している。フック、AWS の読み取り専用ログイン、PR の watch、
テンプレートの同期の仕組みは [docs/claude-code-web.md](docs/claude-code-web.md) にある。
