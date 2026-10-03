# sakekasu-integrated_environment

個人で作っている 4 つの Web アプリ（sakekasu-reinvent、sakekasu-builder、sakekasu-kakeibo、
sakekasu-learning）が共通で使う基盤。アプリごとに別々だったものを、ここに 1 つだけ置く。

| 基盤 | 状態 | 説明 |
| --- | --- | --- |
| 共通ログイン（identity） | 作成中 | 4 アプリで共有する Cognito のユーザープールとログイン画面。[docs/identity.md](docs/identity.md) |
| 共通の監視と Slack 通知 | 予定 | アラートの Slack 通知、AWS Health、サイトの死活監視 |

共通テーマ（`theme/`）は sakekasu-template から同期で配られる。このリポジトリで書き換えない。

## 構成

| パス | 中身 |
| --- | --- |
| `infra/` | AWS の構成（CDK、TypeScript）。デプロイは cdkd で行う予定 |
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

## 開発環境

Claude Code on the web で開発している。フック、AWS の読み取り専用ログイン、PR の watch、
テンプレートの同期の仕組みは [docs/claude-code-web.md](docs/claude-code-web.md) にある。
