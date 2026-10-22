#!/usr/bin/env bash
# Bash ツール実行前に、AWS CLI の変更操作をクラウドセッションでだけ拒否する PreToolUse フック。
#
# permissions.deny に書くとリポジトリ共有のためローカルの正当な管理作業まで止まる
# （sso-admin create-permission-set などが実行できなくなる）。クラウドだけに効かせたいが
# settings.json の permissions には環境による出し分けがないため、フックで判定する。
set -euo pipefail

# ローカルセッションでは何も判定しない。stdin を捨てて即座に抜ける
# （node の起動を挟まないよう、判定より前に返す）。
# 共通の関数が読めないときは、素通りさせずに判定する側に倒す
# shellcheck source=lib/aws-verify-common.sh
if . "$(dirname "$0")/lib/aws-verify-common.sh" 2> /dev/null && ! is_remote; then
  cat > /dev/null
  exit 0
fi

exec node "$(dirname "$0")/deny-aws-writes.mjs"
