#!/usr/bin/env bash
# Claude Code on the web のクラウドセッション用セットアップ。
# .claude/settings.json の SessionStart フックから毎セッション呼ばれる。
#
# このファイルはテンプレートと同じ中身を保つ（managed）。リポジトリごとの違いは次の 2 か所に書く。
#   scripts/cloud-setup.conf  npm ci を走らせるディレクトリ（NPM_DIRS）
#   scripts/cloud-setup.d/    追加のセットアップ。*.sh を名前順に bash で走らせる（bun の導入など）
set -euo pipefail

# ローカルセッションでは何もしない（このフックはリポジトリ共有設定のため、
# ローカルの Claude Code でも発火する。クラウドVMだけを対象にする）。
# 判定は AWS のスクリプトやフックと同じ関数を使い、CLAUDE_CODE_REMOTE=1 でも動かす
# shellcheck source=lib/aws-verify-common.sh
. "$(dirname "$0")/lib/aws-verify-common.sh"
if ! is_remote; then
  exit 0
fi

cd "$(dirname "$0")/.."

# npm ci を走らせるディレクトリ。scripts/cloud-setup.conf の NPM_DIRS に空白区切りで並べる
# （無ければ . と infra）。package-lock.json が無いものは飛ばすので、テンプレートから作った直後
# （まだ何も無い）でも落ちない
npm_dirs_conf=""
if [ -f scripts/cloud-setup.conf ]; then
  npm_dirs_conf=$(sed -n 's/^NPM_DIRS=//p' scripts/cloud-setup.conf | tail -1)
fi
read -r -a NPM_DIRS <<< "${npm_dirs_conf:-. infra}"

hash_file() {
  # クラウドVM（Linux）は sha256sum、macOS は shasum
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi | cut -d' ' -f1
}

# 環境キャッシュから再開したセッションには node_modules が残っているが、
# ディレクトリの有無だけで npm ci を省くと、package-lock.json だけ更新された
# ブランチで依存が古いまま動いてしまう。インストール時のロックファイルの
# ハッシュを控えておき、一致するときだけ省く
install_if_needed() {
  local dir=$1
  [ -f "$dir/package-lock.json" ] || return 0
  local marker="$dir/node_modules/.package-lock.sha256"
  local current
  current=$(hash_file "$dir/package-lock.json")
  if [ "$(cat "$marker" 2>/dev/null)" != "$current" ]; then
    (cd "$dir" && npm ci)
    # 依存が 1 つも無いと npm ci は node_modules を作らない
    mkdir -p "$dir/node_modules"
    echo "$current" > "$marker"
  fi
}

for dir in "${NPM_DIRS[@]}"; do
  install_if_needed "$dir"
done

# リポジトリ固有の追加のセットアップ。1 つが失敗しても、残りと運用方針の出力は続ける
# （運用方針が出ないと、そのセッションは watch や日本語の約束を知らないまま始まる）
for extra in scripts/cloud-setup.d/*.sh; do
  [ -f "$extra" ] || continue
  bash "$extra" || echo "$extra が失敗した（終了コード $?）。セッションは続ける。"
done

# セッション開始時の運用方針。SessionStart フックの標準出力はそのまま Claude の
# 文脈に入るので、CLAUDE.md と同じ内容をここでも一度渡しておく。CLAUDE.md は
# 長いセッションでは押し流されるが、こちらは毎セッションの先頭に必ず載る
cat << 'POLICY'

[session policy]
- AWS の確認が要るときは、指示を待たずに `bash scripts/aws-sso-login.sh` を実行し、
  出力された URL とコードをそのままユーザーに提示して承認を待つ。以降の AWS CLI には
  必ず `--profile verify`（アプリ）/ `verify-org`（管理）/ `verify-ops`（運用ツール）の
  どれかを付ける（どれも読み取り専用）。
- PR を作ったら、指示を待たずに subscribe_pr_activity でその PR を watch する。
- 応答は日本語で書く。
POLICY

# 環境変数 SAKEKASU_AWS_LOGIN=1 を設定した環境では、AWS の確認を待たずに
# セッション開始の時点でログインまで済ませる。既定で走らせないのは、AWS を
# 触らないセッションにまで AWS CLI の 70MB 超のダウンロードを負わせないため
if [ "${SAKEKASU_AWS_LOGIN:-}" = "1" ]; then
  echo
  bash "$(dirname "$0")/aws-sso-login.sh" || echo "AWS SSO のログイン開始に失敗した。必要になった時点で再実行する。"
fi
