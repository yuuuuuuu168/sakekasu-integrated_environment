import { createHmac } from 'node:crypto';
import { appForAlarm, PLATFORM_APP, UNKNOWN_APP } from '../shared/app-label';
import { cachedSecureParameter } from '../shared/ssm';
import { parseSnsMessage, type AlarmMessage, type HealthEvent, type SnsEvent } from '../shared/sns';
import { clipText } from '../shared/text';

/*
 * 4 アプリ共通のアラートを AWS DevOps Agent の Webhook へ転送し、調査を自動で始めさせる。
 * 作りは sakekasu-builder の lambda/devops-agent-webhook を写し、次の 2 点を変えた。
 *
 *   - 設定は Secrets Manager ではなく SSM の SecureString から読む。Slack の Webhook URL と同じ置き方で、
 *     このリポジトリのロールの境界（lib/role-boundary.ts）が `/sakekasu-integrated/*` の
 *     ssm:GetParameter だけを許しているため
 *   - どのアプリのアラームかをアラーム名の接頭辞から引き（slack-notifier と同じ表）、本文とサービス名に出す
 */

/** Webhook の URL と署名鍵を JSON で入れた SSM パラメータ（SecureString）の名前 */
const WEBHOOK_PARAMETER_NAME = process.env.WEBHOOK_PARAMETER_NAME!;
/**
 * この Lambda 自身の失敗を監視するアラーム名。
 *
 * 転送に失敗するとこのアラームが鳴り、それが同じトピックを通って
 * また転送されてくる。届かないことを届けようとして無駄に調査を起こすため、
 * 名前で突き合わせて捨てる
 */
const SELF_ALARM_NAME = process.env.SELF_ALARM_NAME ?? '';
/** どのアプリのものとも言えないイベント（AWS Health など）の調査対象サービス名 */
const PLATFORM_SERVICE_NAME = 'sakekasu-integrated';

/** Webhook は1回の呼び出しで返ってこなければ諦める（SNS 側が再試行する） */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 調査依頼の本文に入れる文字数の上限。
 *
 * アラームの説明文と発報の理由は長さの保証がない自由記述で、本文を読むのは
 * エージェント（LLM）になる。際限なく渡すと調査の指示を押しのけてしまうため、
 * 項目ごとと本文全体の両方で切る
 */
const MAX_FIELD_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 4_000;
/** 見出しは一覧と Slack の投稿に出るため、本文よりさらに短く抑える */
const MAX_TITLE_CHARS = 200;

/**
 * Webhook の送り先として許すホスト名。
 *
 * 最初は内部向けのアドレスを1つずつ弾く形にしていたが、同じ宛先は別の書き方でも
 * 表せる（`::ffff:169.254.169.254` のような IPv4 射影の IPv6、8進数表記の IPv4、
 * 6to4 など）ため、塞ぎ漏れを追いかけ続けることになる。送り先は AWS が発行する
 * Webhook エンドポイントの1つに決まっているので、許す形を書く方に変えた。
 *
 * 実際の値は `https://event-ai.<region>.api.aws/webhook/generic/<id>`。
 * `api.aws` 配下は AWS のサービスエンドポイント専用で第三者が取得できないため、
 * ここを通るホストは内部アドレスにも攻撃者のドメインにもならない。
 * AWS 側がホスト名を変えたらここも直す（疎通確認で分かる）
 */
const ALLOWED_WEBHOOK_HOST = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.api\.aws$/;

/** 調査の優先度。DevOps Agent の Webhook スキーマで決まっている値 */
type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';

/** DevOps Agent の Webhook が受け取る本文 */
export interface IncidentPayload {
  eventType: 'incident';
  incidentId: string;
  action: 'created';
  priority: Priority;
  title: string;
  description: string;
  timestamp: string;
  service: string;
  data: Record<string, unknown>;
}

/**
 * アラーム名から調査の優先度を決める。
 *
 * DevOps Agent は優先度で調査の深さを変えないが、Web アプリの一覧と
 * Slack 投稿に出るため、「今すぐ見るべきか」が人間に伝わる粒度にしておく。
 * 4 アプリのアラーム名（docs/monitoring.md の表）をまたいで、上から順に最初に当たったものを使う。
 * どちらにも当たらないもの（Lambda のエラー、同期の停止、スロットルなど）は HIGH になる
 */
const PRIORITY_RULES: { match: RegExp; priority: Priority }[] = [
  // 利用者からは見えないか、代わりの経路で動き続けているもの（通知の失敗・後片付けの失敗・
  // 監視の停止・LLM のフォールバック・呼び出し数の急増）。
  // CRITICAL より先に見るのは、監視そのものの停止を表す watcher-* が名前に監視対象
  // （health-check など）を含むため。壊れているのは監視の側なので MEDIUM に置く
  {
    match: /image-delete-fail|slack-notifier-failure|watcher-|fallback|invocations-high/,
    priority: 'MEDIUM',
  },
  // 利用者がサイトを開けない・ログインできない・API が 5xx を返す
  {
    match: /^sakekasu-integrated-health-check-|health-check-frontend|appsync-5xx|api-5xx/,
    priority: 'CRITICAL',
  },
];

export function priorityForAlarm(alarmName: string): Priority {
  const rule = PRIORITY_RULES.find((r) => r.match.test(alarmName));
  // 想定していないアラームは軽く扱わない。増やしたときに黙って埋もれるより、
  // 鳴りすぎて優先度の表を直す方に倒す
  return rule?.priority ?? 'HIGH';
}

/**
 * 調査の識別子。同じ値で送ると DevOps Agent 側で重複として捨てられる。
 *
 * アラーム名だけだと2度目の発報が捨てられてしまうため、状態が変わった時刻を
 * 足して「この発報」を表す。逆に SNS の再試行では同じ値になるので、
 * 転送が二重に走っても調査は1件で済む
 */
export function buildIncidentId(parts: (string | undefined)[]): string {
  const raw = parts.filter((p) => !!p).join('-');
  // 記号の扱いは Webhook 側の実装に依存するため、英数と - _ . : だけに寄せる。
  // アンダースコアを残すのは、AWS Health のイベント種別（AWS_..._ISSUE）が
  // 潰れて読めなくなるのを避けるため
  return raw.replace(/[^A-Za-z0-9\-._:]/g, '-').slice(0, 200) || 'unknown-incident';
}

/**
 * 長すぎる自由記述を、省略の印を含めて max 文字に切り詰める。切ったことが読み手に分かるようにしておく。
 * 絵文字の途中では切らない（壊れた片割れが本文に入ると Webhook に拒否される）
 */
export function clip(value: string, max: number): string {
  return clipText(value, max, '…（以下省略）');
}

/**
 * Webhook の timestamp を ISO-8601 に揃える。
 *
 * AWS Health の startTime は RFC-1123（"Fri, 27 Jan 2023 06:02:51 GMT"）、
 * CloudWatch アラームの StateChangeTime はオフセットにコロンが無い形式
 * （"2026-08-09T08:00:00.000+0000"）で届く。どちらもそのまま渡すと解釈を
 * 受け取り側に委ねることになるため、ここで揃えてから送る。
 * 解釈できない値は undefined にして、呼び出し側の代替（SNS の時刻）に任せる
 */
export function toIsoTimestamp(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * 調査の対象サービス名。DevOps Agent 側の一覧に出る。
 *
 * リポジトリ名に揃える（`sakekasu-kakeibo` など）。builder の転送が付けていた名前（`sakekasu-builder`）とも
 * 一致するので、移す前の調査と同じ並びに出る
 */
export function serviceForApp(app: string): string {
  if (app === PLATFORM_APP || app === UNKNOWN_APP) return PLATFORM_SERVICE_NAME;
  return `sakekasu-${app}`;
}

/** アラームから調査依頼を組み立てる。 */
function fromAlarm(alarm: AlarmMessage, snsTimestamp: string): IncidentPayload | null {
  const alarmName = alarm.AlarmName;

  // 復旧（OK）とデータ不足では調査しない。エージェントは秒課金のため、
  // 「壊れている間」だけに絞る
  if (alarm.NewStateValue !== 'ALARM') return null;
  if (SELF_ALARM_NAME && alarmName === SELF_ALARM_NAME) return null;

  const trigger = alarm.Trigger ?? {};
  const stateChangeTime = toIsoTimestamp(alarm.StateChangeTime) ?? snsTimestamp;
  const app = appForAlarm(alarmName);
  const lines = [
    app === UNKNOWN_APP
      ? 'sakekasu の AWS アカウントで CloudWatch アラームが発報しました（どのアプリのものかはアラーム名から判別できませんでした）。'
      : `sakekasu の ${app} で CloudWatch アラームが発報しました。`,
    alarm.AlarmDescription
      ? `アラームの説明: ${clip(alarm.AlarmDescription, MAX_FIELD_CHARS)}`
      : null,
    alarm.NewStateReason ? `発報の理由: ${clip(alarm.NewStateReason, MAX_FIELD_CHARS)}` : null,
    trigger.MetricName
      ? `メトリクス: ${trigger.Namespace ?? '(名前空間不明)'} / ${trigger.MetricName}`
      : null,
    typeof trigger.Threshold === 'number'
      ? `しきい値: ${trigger.ComparisonOperator ?? ''} ${trigger.Threshold}`
      : null,
    `アカウント: ${alarm.AWSAccountId ?? '不明'} / リージョン: ${alarm.Region ?? '不明'}`,
  ].filter((line): line is string => line !== null);

  return {
    eventType: 'incident',
    incidentId: buildIncidentId([alarmName, stateChangeTime]),
    action: 'created',
    priority: priorityForAlarm(alarmName),
    title: clip(`CloudWatch アラーム: ${alarmName}`, MAX_TITLE_CHARS),
    description: clip(lines.join('\n'), MAX_DESCRIPTION_CHARS),
    timestamp: stateChangeTime,
    service: serviceForApp(app),
    // 元のイベントをそのまま添える。エージェントが自分で読み解けるようにする
    data: { source: 'cloudwatch-alarm', app, alarm },
  };
}

/**
 * AWS Health のイベントから調査依頼を組み立てる。
 *
 * こちらで直せる事象ではないが、影響範囲の切り分け（自分のどのリソースが
 * 巻き込まれているか）はエージェントの得意分野なので調査に回す
 */
function fromHealthEvent(event: HealthEvent, snsTimestamp: string): IncidentPayload | null {
  const detail = event.detail ?? {};

  // 予定された変更やお知らせで調査を起こしても意味がないため、障害だけに絞る
  if (detail.eventTypeCategory !== 'issue') return null;

  const entities = (detail.affectedEntities ?? [])
    .map((e) => e.entityValue)
    .filter((v): v is string => !!v);

  // event.region はイベントが配信されたリージョンで、障害が起きた場所とは限らない。
  // グローバルなサービスの障害は us-east-1 から転送されてくるため、これを使うと
  // 「ap-northeast-1 の障害」と読めてしまい調査を誤った方向に引っ張る
  const affectedRegion = detail.eventRegion ?? event.region ?? 'リージョン不明';
  const startTime =
    toIsoTimestamp(detail.startTime) ?? toIsoTimestamp(event.time) ?? snsTimestamp;

  const lines = [
    `AWS 側の障害イベントを受け取りました（${detail.service ?? 'サービス不明'} / ${affectedRegion}）。`,
    detail.eventTypeCode
      ? `イベント種別: ${clip(detail.eventTypeCode, MAX_FIELD_CHARS)}`
      : null,
    detail.eventDescription?.[0]?.latestDescription
      ? clip(detail.eventDescription[0].latestDescription, MAX_FIELD_CHARS)
      : null,
    entities.length > 0
      ? `影響を受けるリソース: ${clip(entities.join(', '), MAX_FIELD_CHARS)}`
      : null,
  ].filter((line): line is string => line !== null);

  return {
    eventType: 'incident',
    incidentId: buildIncidentId([
      detail.eventArn ?? detail.eventTypeCode ?? 'aws-health',
      detail.eventArn ? undefined : startTime,
    ]),
    action: 'created',
    priority: 'HIGH',
    title: clip(`AWS Health 障害: ${detail.service ?? '不明'}`, MAX_TITLE_CHARS),
    description: clip(lines.join('\n'), MAX_DESCRIPTION_CHARS),
    timestamp: startTime,
    // アカウント全体の話で、どれか 1 つのアプリのものではない
    service: PLATFORM_SERVICE_NAME,
    data: { source: 'aws-health', event },
  };
}

/**
 * SNS の1件から調査依頼を組み立てる。調査に回さないものは null を返す。
 *
 * アラームでも Health イベントでもない本文（外形監視からの任意メッセージなど）は
 * 調査の材料が無いので送らない
 */
export function buildIncident(
  message: string,
  snsTimestamp: string,
): IncidentPayload | null {
  const parsed = parseSnsMessage(message);
  if (parsed.kind === 'health') return fromHealthEvent(parsed.event, snsTimestamp);
  if (parsed.kind === 'alarm') return fromAlarm(parsed.alarm, snsTimestamp);
  return null;
}

interface WebhookConfig {
  webhookUrl: string;
  signingSecret: string;
}

/**
 * Webhook の URL が https であることを確かめる。
 *
 * 値の出所は手で登録した SSM パラメータだが、ここは外から入った文字列を
 * そのまま fetch に渡す唯一の場所になる。登録の取り違えや書き間違いが
 * 平文送信や別プロトコルへの送信にならないよう、送る前に弾く
 */
export function assertHttpsUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 値そのものはメッセージに載せない（ログに URL が残る）
    throw new Error(`Webhook の webhookUrl が URL として読めません: ${WEBHOOK_PARAMETER_NAME}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Webhook の webhookUrl は https でなければなりません（${parsed.protocol} が指定されています）`,
    );
  }
  // IPv6 は hostname が [] 付きで返る
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!ALLOWED_WEBHOOK_HOST.test(hostname)) {
    // ホスト名は秘密ではない（鍵と Webhook の ID はパスと本文の側）。
    // 出さないと登録ミスの切り分けができないので、ここだけは載せる
    throw new Error(
      `Webhook の webhookUrl は api.aws のエンドポイントでなければなりません（${hostname} が指定されています）`,
    );
  }
  return raw;
}

/** SSM の値（JSON）を読んで確かめる */
function parseWebhookConfig(raw: string): WebhookConfig {
  let parsed: Partial<WebhookConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<WebhookConfig>;
  } catch {
    // JSON.parse の例外は読めなかった中身の先頭をメッセージに載せる。
    // ここで握らないと URL や署名鍵がそのままログに出る
    throw new Error(`Webhook の設定が JSON として読めません: ${WEBHOOK_PARAMETER_NAME}`);
  }

  if (!parsed.webhookUrl || !parsed.signingSecret) {
    throw new Error(
      `Webhook の設定に webhookUrl / signingSecret がありません: ${WEBHOOK_PARAMETER_NAME}`,
    );
  }

  return {
    webhookUrl: assertHttpsUrl(parsed.webhookUrl),
    signingSecret: parsed.signingSecret,
  };
}

/** 読んだ設定は期限付きで使い回す（発報のたびに SSM を叩かず、鍵の入れ替えにも追いつく） */
const getWebhookConfig = cachedSecureParameter(WEBHOOK_PARAMETER_NAME, parseWebhookConfig);

/**
 * HMAC 署名を作る。署名の対象は「タイムスタンプ:本文」で、
 * 時刻を含めることで古い要求の再送を Webhook 側で弾けるようにしている
 */
export function sign(timestamp: string, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${payload}`, 'utf8').digest('base64');
}

async function postToWebhook(incident: IncidentPayload): Promise<void> {
  const { webhookUrl, signingSecret } = await getWebhookConfig();

  const body = JSON.stringify(incident);
  const timestamp = new Date().toISOString();

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-amzn-event-timestamp': timestamp,
      'x-amzn-event-signature': sign(timestamp, body, signingSecret),
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // 転送先の検証は設定を読んだときの1回だけなので、リダイレクトを追うと
    // 検証を通っていない先へ本文ごと運んでしまう。307/308 は POST と本文を保つ
    redirect: 'error',
  });

  if (!response.ok) {
    // URL も署名鍵もログに残さない（本文にも入れない）
    throw new Error(`DevOps Agent への転送に失敗しました (HTTP ${response.status})`);
  }
}

export const handler = async (event: SnsEvent): Promise<void> => {
  for (const record of event.Records) {
    const incident = buildIncident(record.Sns.Message, record.Sns.Timestamp);
    if (!incident) {
      console.log('調査の対象外のため転送しませんでした');
      continue;
    }

    await postToWebhook(incident);
    console.log(
      `調査を依頼しました: ${incident.incidentId}（優先度 ${incident.priority}）`,
    );
  }
};
