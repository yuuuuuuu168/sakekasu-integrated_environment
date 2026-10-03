/** このリポジトリのスタック名・リソース名の接頭辞 */
export const PREFIX = 'sakekasu-integrated';

/** 共通ログイン画面のドメイン */
export const AUTH_DOMAIN = 'auth.sakekasu-builder.com';

export const REGION = 'ap-northeast-1';

/** 信頼する GitHub リポジトリ */
export const REPOSITORY = 'yuuuuuuu168/sakekasu-integrated_environment';

/** GitHub Actions が引き受けるロールの名前 */
export const DEPLOY_ROLE_NAME = `${PREFIX}-github-actions-deploy`;
export const CDKD_DEPLOY_ROLE_NAME = `${PREFIX}-github-actions-cdkd`;
