#!/usr/bin/env bash
# verify プロファイルの用意から SSO ログインの開始までを、指示なしで一度に済ませる。
#
# デバイスコードフローの `aws sso login` は、URLとコードを出したあと承認されるまで
# 前面で待ち続ける。Bash ツールから素直に実行すると、待っている間ずっと出力が
# 返らず、肝心のURLとコードをユーザーに渡せない（承認できないので永久に待つ）。
# そのためログインは背後に回し、ログに出たURLとコードだけを拾って先に返す。
#
#   引数なし / --start : プロファイルを用意してログインを開始し、URLとコードを出す
#   --wait             : 承認の完了を待つ（既定 180 秒）
#   --status           : 認証済みかどうかだけを返す
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/aws-verify-common.sh
. "$script_dir/lib/aws-verify-common.sh"
profile=verify
log=${SAKEKASU_SSO_LOG:-/tmp/sakekasu-aws-sso-login.log}
# URLとコードがログに出るまでの待ち時間。SessionStart フックから呼ばれても
# セッション開始を長く止めないよう短くしてある
code_timeout=${SAKEKASU_SSO_CODE_TIMEOUT:-30}
# ユーザーが承認を終えるまでの待ち時間
approval_timeout=${SAKEKASU_SSO_APPROVAL_TIMEOUT:-180}

mode=start
case "${1:-}" in
  '' | --start) mode=start ;;
  --wait) mode=wait ;;
  --status) mode=status ;;
  *)
    echo "usage: $0 [--start|--wait|--status]" >&2
    exit 2
    ;;
esac

# ローカルセッションでは何もしない。setup-aws-profile.sh が ~/.aws/config を
# 上書きするため、リポジトリ共有のこのスクリプトもクラウドだけを対象にする
if ! is_remote; then
  echo "Local session detected. Skipped (use your own AWS profile)."
  exit 0
fi

is_authenticated() {
  command -v aws > /dev/null 2>&1 || return 1
  aws sts get-caller-identity --profile "$profile" > /dev/null 2>&1
}

# setup-aws-profile.sh は呼ぶたびに ~/.aws/config を書き直して控えを増やすので、
# AWS CLI v2 が無いときと、aws-verify.conf の中身が書き出し済みの設定と違うときだけ呼ぶ。
# 後者は setup-aws-profile.sh が先頭に残す verify-config 行で見分ける
needs_setup() {
  command -v aws > /dev/null 2>&1 || return 0
  case "$(aws --version 2>&1)" in
    aws-cli/2.*) ;;
    *) return 0 ;;
  esac
  grep -q '^\[sso-session verify\]' ~/.aws/config 2> /dev/null || return 0
  load_verify_conf "$script_dir/aws-verify.conf"
  [ "$(head -1 ~/.aws/config)" = "$(verify_config_line)" ] || return 0
  return 1
}

# 背後のログインのプロセスに当てるパターン。実行ファイルの aws から始まるものだけにする。
# 単に文字列で探すと、その文字列をコマンドに含むだけのシェルまで当たり、stop_login で止めてしまう
login_pattern="(^|/)aws sso login --profile $profile( |\$)"

# 背後のログインがまだ生きているか。pgrep が無い環境では判断できないので生きている扱い
login_running() {
  command -v pgrep > /dev/null 2>&1 || return 0
  pgrep -f "$login_pattern" > /dev/null 2>&1
}

# 背後のログインを止める。残しておくと、承認されないまま古いコードで待ち続ける
stop_login() {
  command -v pkill > /dev/null 2>&1 || return 0
  pkill -f "$login_pattern" > /dev/null 2>&1 || true
}

read_url() { grep -Eo 'https://[^[:space:]]+' "$log" 2> /dev/null | tail -1 || true; }
read_code() { grep -Eo '\b[A-Z0-9]{4}-[A-Z0-9]{4}\b' "$log" 2> /dev/null | tail -1 || true; }

print_code() {
  cat << EOF
AWS SSO ログインを開始した。次のURLを開いてコードを入力し、承認する。

  URL : $1
  CODE: $2

承認が済んだら 'bash scripts/aws-sso-login.sh --wait' で完了を確かめてから、
以降の AWS CLI には必ず --profile verify（または verify-org / verify-ops など
aws-verify.conf で足したプロファイル）を付ける。1回の承認で全プロファイルに入れる。
EOF
}

wait_for_approval() {
  local limit=$1 waited=0
  while [ "$waited" -lt "$limit" ]; do
    if is_authenticated; then
      echo "AWS SSO: authenticated (profile $profile)."
      aws sts get-caller-identity --profile "$profile" --output text --query 'Arn' 2> /dev/null || true
      return 0
    fi
    # ログインが終わっているのに認証できていなければ、待っても変わらない
    if ! login_running && ! is_authenticated; then
      echo "AWS SSO: ログインの処理が終わっているが、認証できていない。ログの中身は次のとおり。" >&2
      tail -20 "$log" >&2 2> /dev/null || true
      echo "引数なしで再実行して、新しいURLとコードで承認し直す。" >&2
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  echo "AWS SSO: まだ承認されていない（${limit}秒待った）。承認を終えてから --wait を再実行する。" >&2
  return 1
}

case "$mode" in
  status)
    if is_authenticated; then
      echo "AWS SSO: authenticated (profile $profile)."
      exit 0
    fi
    echo "AWS SSO: not authenticated."
    exit 1
    ;;
  wait)
    wait_for_approval "$approval_timeout"
    exit $?
    ;;
esac

# 設定の書き出しを認証の確認より先に済ませる。認証済みで抜けてしまうと、
# aws-verify.conf でプロファイルを足しても ~/.aws/config に反映されない。
# トークンは sso-session 単位で持つので、書き直しても認証は切れない
if needs_setup; then
  bash "$script_dir/setup-aws-profile.sh"
fi

if is_authenticated; then
  echo "AWS SSO: already authenticated (profile $profile). ログイン不要。"
  exit 0
fi

# 承認待ちのログインが残っていれば、新しく始めずにそのURLとコードを出し直す。
# 始め直すとユーザーが入力しかけのコードが無効になり、古いログインも背後に残る。
# 動いているのにまだURLとコードが出ていないもの（起動の途中や、詰まったもの）は止めて始め直す。
# pgrep が無いと生きているかを判断できないので、従来どおり始め直す
if command -v pgrep > /dev/null 2>&1 && login_running; then
  pending_url=$(read_url)
  pending_code=$(read_code)
  if [ -n "$pending_url" ] && [ -n "$pending_code" ]; then
    print_code "$pending_url" "$pending_code"
    exit 0
  fi
  stop_login
fi

# ログには承認用のURLとコードが載る。他人が拾って承認を進めないよう、
# 同じマシン上の他ユーザーからは読めないようにしておく
umask 077
rm -f "$log"

start_login() {
  if command -v setsid > /dev/null 2>&1; then
    # フックやツール呼び出しのプロセスグループごと落とされても、
    # 承認待ちのログインが生き残るように別セッションで起こす
    setsid nohup aws sso login --profile "$profile" "$@" > "$log" 2>&1 < /dev/null &
  else
    nohup aws sso login --profile "$profile" "$@" > "$log" 2>&1 < /dev/null &
  fi
}

# 待ち時間の半分を使ってURLとコードを探す。--no-browser を解さない CLI に当たった
# 場合は、残り半分で付けずにやり直す（v2 でも古い版には無い）
poll_for_code() {
  local limit=$1 waited=0 url code
  while [ "$waited" -lt "$limit" ]; do
    url=$(read_url)
    code=$(read_code)
    if [ -n "$url" ] && [ -n "$code" ]; then
      printf '%s\n%s\n' "$url" "$code"
      return 0
    fi
    case "$(cat "$log" 2> /dev/null)" in
      *"Unknown options"* | *"Invalid choice"* | *"unrecognized arguments"*) return 2 ;;
    esac
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

half=$((code_timeout / 2))
[ "$half" -lt 5 ] && half=5

start_login --use-device-code --no-browser
result=$(poll_for_code "$half") && status=0 || status=$?

if [ "$status" -eq 2 ]; then
  rm -f "$log"
  start_login --use-device-code
  result=$(poll_for_code "$half") && status=0 || status=$?
fi

if [ "$status" -ne 0 ]; then
  stop_login
  echo "AWS SSO: ログインのURLとコードを取得できなかった。ログの中身は次のとおり。" >&2
  tail -20 "$log" >&2 2> /dev/null || true
  echo "到達性（awsapps.com / *.amazonaws.com）がクラウド環境のネットワーク設定で許可されているかを確認する。" >&2
  exit 1
fi

print_code "$(printf '%s' "$result" | sed -n '1p')" "$(printf '%s' "$result" | sed -n '2p')"
