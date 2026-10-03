#!/usr/bin/env bash
# クラウドセッションから読み取り専用のAWS確認作業をするための verify プロファイルを配置する。
# 認証は IAM Identity Center のデバイスコードフローで毎回取得するため、
# ここで書き出す ~/.aws/config にシークレットは含まれない（SSOのURL・アカウントID・ロール名のみ）。
set -euo pipefail

# ローカルセッションでは何もしない。ローカルの ~/.aws/config には
# 開発用の複数プロファイルが入っており、上書きすると失われるため。
# True / TRUE / 1 でも通るよう、比較前に小文字へ正規化する
remote=$(printf '%s' "${CLAUDE_CODE_REMOTE:-}" | tr '[:upper:]' '[:lower:]')
if [ "$remote" != "true" ] && [ "$remote" != "1" ]; then
  echo "Local session detected. Skipped (would overwrite ~/.aws/config)."
  exit 0
fi

# SSO の値は scripts/aws-verify.conf から読む。同名の環境変数があればそちらを優先する
# （クラウド環境の Environment variables で上書きできるように）。AWS CLI を落とす前に
# 確かめるのは、未設定のまま 70MB を落としてから失敗させないため
conf="$(cd "$(dirname "$0")" && pwd)/aws-verify.conf"
for key in SSO_START_URL SSO_REGION SSO_ACCOUNT_ID SSO_ROLE_NAME AWS_VERIFY_REGION; do
  if [ -z "${!key:-}" ] && [ -f "$conf" ]; then
    value=$(sed -n "s/^${key}=//p" "$conf" | tail -1)
    printf -v "$key" '%s' "$value"
  fi
done
missing=""
for key in SSO_START_URL SSO_REGION SSO_ACCOUNT_ID SSO_ROLE_NAME AWS_VERIFY_REGION; do
  [ -n "${!key:-}" ] || missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "scripts/aws-verify.conf に未設定の値がある:$missing" >&2
  echo "アプリの AWS アカウントに合わせて埋めてから再実行する。" >&2
  exit 1
fi

# verify 以外のプロファイル（任意）。「名前:アカウントID」をカンマで並べる
if [ -z "${SSO_EXTRA_PROFILES+set}" ] && [ -f "$conf" ]; then
  SSO_EXTRA_PROFILES=$(sed -n "s/^SSO_EXTRA_PROFILES=//p" "$conf" | tail -1)
fi
extra_profiles=()
if [ -n "${SSO_EXTRA_PROFILES:-}" ]; then
  IFS=',' read -r -a extra_profiles <<< "$SSO_EXTRA_PROFILES"
  for entry in "${extra_profiles[@]}"; do
    if ! [[ "$entry" =~ ^verify-[a-z0-9-]+:[0-9]{12}$ ]]; then
      echo "SSO_EXTRA_PROFILES の形式が不正: '$entry'（verify-名前:12桁のアカウントID）" >&2
      exit 1
    fi
  done
fi

# AWS CLI Team の署名鍵の指紋。AWS の公式インストール手順に載っているもので、
# 公開鍵そのものは scripts/aws-cli-public-key.asc に置いてある（鍵の期限は 2027-07-01）。
#
# この検証が守るのは配信経路（CDN の侵害や MITM）であって、リポジトリ自体ではない。
# 鍵と指紋はどちらもこのリポジトリにあるため、両方を書き換える変更が入れば検証は
# 通ってしまう。鍵を差し替える PR をレビューするときは、値をリポジトリ内で
# 突き合わせるのではなく、AWS の公式手順の記載と照らすこと。
AWS_CLI_KEY_FINGERPRINT=FB5DB77FD5C118B80511ADA8A6310ACC4672475C

# クラウドのコンテナには AWS CLI が入っていない。使い捨てのコンテナなので
# 毎セッション導入が要る。SSO のデバイスコードフローは v1 では動かないため、
# 「入っているか」ではなく「v2 が入っているか」で判定する。
# 環境キャッシュから再開したセッションには /usr/local/bin/aws が残っている場合がある。
ensure_aws_cli_v2() {
  if command -v aws > /dev/null 2>&1; then
    # v1 はバージョンを stderr に出すため 2>&1 でまとめて受ける
    version=$(aws --version 2>&1 || true)
    case "$version" in
      aws-cli/2.*)
        echo "AWS CLI already installed: $version"
        return 0
        ;;
      *)
        echo "Found non-v2 AWS CLI ($version). Installing v2."
        ;;
    esac
  fi

  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      return 1
      ;;
  esac

  if ! command -v gpg > /dev/null 2>&1; then
    echo "gpg not found. Cannot verify the AWS CLI installer signature." >&2
    return 1
  fi

  script_dir=$(cd "$(dirname "$0")" && pwd)
  base_url="https://awscli.amazonaws.com/awscli-exe-linux-$arch.zip"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Installing AWS CLI v2 ($arch)..."
  curl -fsSL -o "$tmp/awscliv2.zip" "$base_url"
  curl -fsSL -o "$tmp/awscliv2.zip.sig" "$base_url.sig"

  # インストーラを実行する前に PGP 署名を確かめる。配信元と同じホストから
  # 落とすハッシュでは、配信側が乗っ取られたときに検証にならないため、
  # リポジトリに同梱した AWS CLI Team の公開鍵で照合する。
  # 鍵束は $tmp に作り、セッションの ~/.gnupg には触らない
  GNUPGHOME="$tmp/gnupg"
  export GNUPGHOME
  mkdir -p "$GNUPGHOME"
  chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --import "$script_dir/aws-cli-public-key.asc"

  # 判定は終了コードではなく機械可読な出力で行う。終了コードは鍵束に別の鍵が
  # 紛れ込んだ場合に通ってしまううえ、鍵が期限切れでも 0 のまま返る（実測）。
  # grep へ直接パイプすると SIGPIPE と pipefail で誤判定し得るので変数に受ける
  verify_status=$(gpg --batch --status-fd 1 --verify "$tmp/awscliv2.zip.sig" "$tmp/awscliv2.zip" 2> /dev/null || true)

  # 見るのは 2 行。GOODSIG は署名と鍵の両方が健全なときだけ出て、鍵が期限切れ
  # なら EXPKEYSIG、失効していれば REVKEYSIG に置き換わる。VALIDSIG は署名自体の
  # 正当性しか示さず期限切れでも出るので、これだけでは期限切れを見逃す。
  # 一方 GOODSIG は鍵IDまでしか持たないため、指紋の照合は VALIDSIG 側で行う
  verify_failure=""
  case "$verify_status" in
    *"EXPKEYSIG"* | *"KEYEXPIRED"*)
      verify_failure="signing key has expired (update scripts/aws-cli-public-key.asc)"
      ;;
    *"REVKEYSIG"*) verify_failure="signing key has been revoked" ;;
    *"GOODSIG"*) ;;
    *) verify_failure="no good signature" ;;
  esac
  case "$verify_status" in
    *"VALIDSIG $AWS_CLI_KEY_FINGERPRINT"*) ;;
    *) verify_failure="${verify_failure:-signed by an unexpected key}" ;;
  esac
  if [ -n "$verify_failure" ]; then
    echo "Signature verification failed for the AWS CLI installer: $verify_failure. Aborting." >&2
    return 1
  fi
  echo "Installer signature verified ($AWS_CLI_KEY_FINGERPRINT)."
  unset GNUPGHOME

  unzip -q "$tmp/awscliv2.zip" -d "$tmp"
  # --update は既存インストールの有無にかかわらず通る
  "$tmp/aws/install" --update

  rm -rf "$tmp"
  trap - EXIT

  # 直前まで aws が無かった場合、シェルが「見つからない」を覚えているため消す
  hash -r
  echo "AWS CLI installed: $(aws --version 2>&1)"
}

ensure_aws_cli_v2

mkdir -p ~/.aws

# ガードをすり抜けた場合の保険。上書き前に必ず退避する
if [ -f ~/.aws/config ]; then
  backup=~/.aws/config.bak.$(date +%Y%m%d-%H%M%S)
  cp ~/.aws/config "$backup"
  echo "Backed up existing config to $backup"
fi

# 全プロファイルが同じ sso-session を共有する。デバイスコードの承認は1回で済み、
# そのトークンでどのアカウントのロールにも入れる。
# 先頭の verify-config 行は aws-sso-login.sh が「設定が変わったか」を見る目印
write_profile() {
  echo
  echo "[profile $1]"
  echo "sso_session = verify"
  echo "sso_account_id = $2"
  echo "sso_role_name = $SSO_ROLE_NAME"
  echo "region = $AWS_VERIFY_REGION"
  echo "output = json"
}

{
  echo "# verify-config: $SSO_START_URL $SSO_REGION $SSO_ACCOUNT_ID $SSO_ROLE_NAME $AWS_VERIFY_REGION ${SSO_EXTRA_PROFILES:-}"
  echo "[sso-session verify]"
  echo "sso_start_url = $SSO_START_URL"
  echo "sso_region = $SSO_REGION"
  echo "sso_registration_scopes = sso:account:access"
  write_profile verify "$SSO_ACCOUNT_ID"
  for entry in "${extra_profiles[@]}"; do
    write_profile "${entry%%:*}" "${entry#*:}"
  done
} > ~/.aws/config

names="verify"
for entry in "${extra_profiles[@]}"; do
  names="$names, ${entry%%:*}"
done
echo "AWS profiles configured: $names"
