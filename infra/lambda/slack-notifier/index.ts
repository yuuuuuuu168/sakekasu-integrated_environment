import { cachedSecureParameter } from '../shared/ssm';
import { parseSnsMessage, type HealthEvent, type SnsEvent } from '../shared/sns';
import { buildSlackPayload, clip, plainPayload, type SlackPayload } from './blocks';

/*
 * 4 アプリ共通のアラートを Slack へ流す。作りは sakekasu-builder の lambda/slack-notifier を写し、
 * アラームには「どのアプリか」を足した（shared/app-label.ts）。
 *
 * 届くものは 3 通り。
 *   - CloudWatch アラーム（各アプリと共通基盤のもの。ALARM と OK の両方）
 *   - AWS Health（EventBridge 経由。共通基盤だけが持つ）
 *   - それ以外（任意のメッセージ）。件名と本文をそのまま出す
 *
 * 本文の組み立ては blocks.ts にあり、ここは SSM・Slack とのやりとりだけを持つ。
 */

/** 通知に添えるコンソールのリージョン */
const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';

/** Webhook URL を置いた SSM パラメータ（SecureString）から読む */
const getWebhookUrl = cachedSecureParameter(process.env.WEBHOOK_PARAMETER_NAME!, (raw) => raw);

async function postToSlack(payload: SlackPayload): Promise<void> {
  const webhookUrl = await getWebhookUrl();

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // 本文には Webhook URL を含めない（ログに出さない）
    throw new Error(`Slack への送信に失敗しました (HTTP ${response.status})`);
  }
}

/**
 * 受け取った Health イベントをログに残す。
 *
 * Slack に流すだけだと、後から「何が届いたのか」を AWS 側から追えない。
 * Health API（describe-events）は Business 以上のサポート契約がないと呼べず、
 * EventBridge も既定ではイベントを保存しないため、通知が流れたあとは
 * Slack の画面が唯一の記録になってしまう。sakekasu-builder では 2026-08-21 の Connect の
 * 障害通知で、中身を確かめるのにスクリーンショットが要った。
 *
 * アラームの方は CloudWatch のアラーム履歴に残るので、ここでは Health だけ書き出す。
 */
function logHealthEvent(event: HealthEvent): void {
  const detail = event.detail ?? {};
  console.log(
    JSON.stringify({
      kind: 'aws-health-event',
      service: detail.service,
      eventArn: detail.eventArn,
      eventTypeCode: detail.eventTypeCode,
      eventTypeCategory: detail.eventTypeCategory,
      // PUBLIC はリージョン全体の公開情報で、こちらのリソースに影響するとは限らない。
      // 使っていないサービスの通知が届いたときの切り分けに要る
      eventScopeCode: detail.eventScopeCode,
      // region は通知の配信先。実際に影響を受けたのは eventRegion の方
      eventRegion: detail.eventRegion ?? event.region,
      startTime: detail.startTime,
      endTime: detail.endTime,
      affectedEntityCount: (detail.affectedEntities ?? []).length,
      // 本文は数千文字になることがあるので頭だけ残す
      description: clip(detail.eventDescription?.[0]?.latestDescription ?? '', 1000),
    }),
  );
}

export const handler = async (event: SnsEvent): Promise<void> => {
  for (const record of event.Records) {
    const message = parseSnsMessage(record.Sns.Message);

    let payload: SlackPayload;
    try {
      // Slack 送信より先に出す。送信に失敗しても記録は残したい
      if (message.kind === 'health') logHealthEvent(message.event);
      payload = buildSlackPayload(message, record.Sns, REGION);
    } catch (error) {
      // 組み立ての不具合で通知ごと失うより、件名と本文をそのまま流す方がよい。
      // 黙って落とすと不具合に気づけないので、ログには残す
      console.error('通知の組み立てに失敗したため、本文をそのまま流します', error);
      payload = plainPayload(record.Sns);
    }

    await postToSlack(payload);
  }
};
