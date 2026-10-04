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

/*
 * 監視と Slack 通知（docs/monitoring.md）
 */

/** 監視のスタック（ap-northeast-1）と、グローバルの AWS Health を転送するスタック（us-east-1） */
export const MONITORING_STACK_NAME = `${PREFIX}-monitoring`;
export const HEALTH_GLOBAL_STACK_NAME = `${PREFIX}-health-global`;
/** IAM や CloudFront のようなグローバルサービスの AWS Health イベントが届くリージョン */
export const GLOBAL_HEALTH_REGION = 'us-east-1';

/**
 * 4 アプリ共通の通知先トピック。名前は固定。各アプリはこの名前から ARN を組み立てて送る
 * （arn:aws:sns:ap-northeast-1:<account>:sakekasu-integrated-alerts）。変えると全アプリの通知が止まる
 */
export const ALERT_TOPIC_NAME = `${PREFIX}-alerts`;

/** Slack の Incoming Webhook URL を置く SSM パラメータ（SecureString）。人が手で登録する */
export const SLACK_WEBHOOK_PARAMETER_NAME = `/${PREFIX}/monitoring/slack-webhook-url`;

/**
 * 監視の Lambda やイベント転送が使うロールの名前の接頭辞。cdkd 用ロールが作れるロールはこの名前に限る。
 * `${PREFIX}-*` のままにしないのは、GitHub Actions のロール（`${PREFIX}-github-actions-*`）と
 * 名前が重なり、許可の範囲にデプロイ用ロール自身が入ってしまうため
 */
export const APP_ROLE_PREFIX = `${PREFIX}-app-`;

/**
 * 上のロールに付ける Permissions Boundary（管理ポリシー）。cdkd-deploy スタック（CloudFormation）が作る。
 * ARN を名前から組み立てるので、値を変えると作り直しになる
 */
export const ROLE_BOUNDARY_NAME = `${PREFIX}-role-boundary`;

/*
 * apex（sakekasu-builder.com）と www の転送（docs/apex-redirect.md）
 */

/** apex の転送を受け持つスタック。CloudFront に付ける証明書の都合で us-east-1 に置く */
export const APEX_REDIRECT_STACK_NAME = `${PREFIX}-apex-redirect`;
export const APEX_REDIRECT_REGION = 'us-east-1';
/** 転送で受けるドメイン。どちらも親ゾーン（Organization の管理アカウント）にある */
export const APEX_DOMAINS = ['sakekasu-builder.com', 'www.sakekasu-builder.com'];
/** 転送先。builder の画面（sakekasu-builder の docs/sake-subdomain.md） */
export const APEX_REDIRECT_TARGET = 'sake.sakekasu-builder.com';
