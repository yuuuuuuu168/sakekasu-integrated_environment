# shellcheck shell=bash
# AWS の確認用スクリプト（aws-sso-login.sh、setup-aws-profile.sh、deny-aws-writes.sh、cloud-setup.sh）が
# source して使う共通の関数。単独では実行しない。
#
# aws-verify.conf の読み方と ~/.aws/config 先頭の verify-config 行の書式を、書く側（setup-aws-profile.sh）と
# 比べる側（aws-sso-login.sh）で 1 か所にまとめる。別々に書くと、片方だけ直したときに目印が毎回一致しなくなり、
# セッションのたびに ~/.aws/config の書き直しと控えのファイルが増える。

# aws-verify.conf のキー。verify-config 行もこの並びで作る
AWS_VERIFY_KEYS=(SSO_START_URL SSO_REGION SSO_ACCOUNT_ID SSO_ROLE_NAME AWS_VERIFY_REGION SSO_EXTRA_PROFILES)

# クラウドセッションか。True / TRUE / 1 でも通るよう、比べる前に小文字にそろえる
is_remote() {
  local remote
  remote=$(printf '%s' "${CLAUDE_CODE_REMOTE:-}" | tr '[:upper:]' '[:lower:]')
  [ "$remote" = "true" ] || [ "$remote" = "1" ]
}

# aws-verify.conf の値を同名のシェル変数に入れる。同名の環境変数があればそちらを優先する
# （クラウド環境の Environment variables で上書きできるように）。
# SSO_EXTRA_PROFILES だけは空の値でも設定済みとみなす（環境変数を空にして、追加のプロファイルを消せるように）
load_verify_conf() {
  local conf=$1 key value
  for key in "${AWS_VERIFY_KEYS[@]}"; do
    if [ "$key" = SSO_EXTRA_PROFILES ]; then
      [ -z "${!key+set}" ] || continue
    else
      [ -z "${!key:-}" ] || continue
    fi
    value=""
    [ -f "$conf" ] && value=$(sed -n "s/^${key}=//p" "$conf" | tail -1)
    printf -v "$key" '%s' "$value"
  done
}

# ~/.aws/config の先頭に置く目印の行。load_verify_conf のあとに呼ぶ
verify_config_line() {
  local line="# verify-config:" key
  for key in "${AWS_VERIFY_KEYS[@]}"; do
    line="$line ${!key:-}"
  done
  printf '%s\n' "$line"
}
