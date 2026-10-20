import { appForAlarm } from '../shared/app-label';
import { clipText, dropBrokenCharacters } from '../shared/text';
import type { AlarmMessage, HealthEvent, SnsEventRecord, SnsMessage } from '../shared/sns';

/*
 * Slack に送る本文の組み立て。I/O（SSM・fetch）は index.ts にあり、ここは純粋な関数だけを置く。
 */

/** Slack の section text の上限。超えると送信そのものが 400 で失敗する */
const SLACK_TEXT_LIMIT = 2900;
/** Slack の header text の上限。こちらは section よりずっと短い */
const SLACK_HEADER_LIMIT = 150;

/** Slack に送る本文。text は通知プレビューやプッシュ通知に出る */
export interface SlackPayload {
  text: string;
  blocks: unknown[];
}

/**
 * 状態に応じた見出し。復旧も通知して「直ったかどうか」が分かるようにする。
 *
 * ここでは加工しない素の文字列を返す。見出し（plain_text）は記法を解釈しないので
 * エスケープすると実体参照がそのまま見えてしまい、通知プレビュー（mrkdwn）には
 * エスケープが要る、と用途で必要な処理が違うため
 */
function headline(state: string | undefined, rawAlarmName: string): string {
  const alarmName = clip(rawAlarmName, 200);
  // 4 アプリの通知が同じチャンネルに並ぶので、見出しの頭でどのアプリかを分かるようにする
  const app = `[${appForAlarm(rawAlarmName)}]`;
  switch (state) {
    case 'ALARM':
      return `🚨 ${app} 異常を検知しました: ${alarmName}`;
    case 'OK':
      return `✅ ${app} 復旧しました: ${alarmName}`;
    case 'INSUFFICIENT_DATA':
      return `⚠️ ${app} データ不足で判定できません: ${alarmName}`;
    default:
      return `${app} 通知: ${alarmName}`;
  }
}

function alarmConsoleUrl(alarmName: string, region: string): string {
  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}` +
    `#alarmsV2:alarm/${encodeURIComponent(alarmName)}`
  );
}

/** JST での表示。運用しているのが日本時間のため */
function formatJst(iso: string | undefined): string {
  if (!iso) return '不明';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/**
 * Slack の mrkdwn に埋め込む値を無害化する。
 *
 * mrkdwn は `<URL|文字>` をリンク、`<!channel>` を一斉呼び出しとして解釈する。
 * 通知には外部由来の文字列が入るため、そのまま流すと偽のリンクや
 * 不要なメンションを差し込まれる余地が残る。
 */
function escapeMrkdwn(text: string): string {
  // 壊れた文字もここで落とす。この関数は mrkdwn に出す値が必ず通るため、
  // 個別に呼ばれた場合（影響リソースの連結など）も取りこぼさない
  return dropBrokenCharacters(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 長さを詰める。既定は section の上限 */
export function clip(text: string, limit: number = SLACK_TEXT_LIMIT): string {
  return clipText(text, limit);
}

/**
 * mrkdwn に埋め込む値を無害化し、長さも詰める。
 *
 * 二重に適用すると `&lt;` が `&amp;lt;` になって表示が壊れるため、
 * 「mrkdwn として出力する直前に一度だけ」通すこと
 */
function safeText(text: string, limit: number = SLACK_TEXT_LIMIT): string {
  return clip(escapeMrkdwn(text), limit);
}

/**
 * アラームの説明（alarmDescription）の欄。
 *
 * 説明は「鳴ったときに何が起きているか」の文で書いてあり、状態によらず同じものが届く。
 * ALARM ならそのまま「内容」として読めるが、OK やデータ不足のときに同じ見出しで出すと、
 * 復旧したのに異常の文に見えて紛らわしい（2026-10 のデプロイ直後、全アラームの
 * INSUFFICIENT_DATA → OK でこれが並んだ）。ALARM 以外では、何を見ているアラームかの
 * 説明だと分かる欄名と前置きにする
 */
function descriptionText(state: string | undefined, description: string): string {
  const body = safeText(description, 1500);
  switch (state) {
    case 'OK':
      return `*このアラームが見ているもの*\n次の状態になると鳴ります（今は解消しています）:\n${body}`;
    case 'INSUFFICIENT_DATA':
      return `*このアラームが見ているもの*\n次の状態になると鳴ります（今はデータが足りず判定できていません）:\n${body}`;
    default:
      return `*内容*\n${body}`;
  }
}

/**
 * アラーム本文を Slack のブロックに組み立てる。
 * 何が起きたかと、次にどこを見ればよいかが1画面で分かることを優先する。
 */
function buildAlarmBlocks(alarm: AlarmMessage, fallbackTime: string, defaultRegion: string): unknown[] {
  // URL 生成にも使うため、ここで壊れた文字を落としておく
  // （encodeURIComponent は対になっていないサロゲートで例外を投げる）
  const alarmName = dropBrokenCharacters(alarm.AlarmName);
  const region = alarm.Region && /^[a-z0-9-]+$/.test(alarm.Region) ? alarm.Region : defaultRegion;

  const fields = [
    `*アプリ*\n${safeText(appForAlarm(alarmName), 100)}`,
    `*状態*\n${safeText(`${alarm.OldStateValue ?? '?'} → ${alarm.NewStateValue ?? '?'}`, 100)}`,
    `*発生時刻*\n${safeText(formatJst(alarm.StateChangeTime ?? fallbackTime), 100)}`,
  ];
  if (alarm.Trigger?.MetricName) {
    fields.push(
      `*メトリクス*\n${safeText(`${alarm.Trigger.Namespace ?? ''} / ${alarm.Trigger.MetricName}`, 200)}`,
    );
  }
  if (typeof alarm.Trigger?.Threshold === 'number') {
    fields.push(`*しきい値*\n${alarm.Trigger.Threshold}`);
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        // 見出しは 150 文字を超えると送信ごと失敗する
        text: clip(headline(alarm.NewStateValue, alarmName), SLACK_HEADER_LIMIT),
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: fields.map((text) => ({ type: 'mrkdwn', text })),
    },
  ];

  if (alarm.AlarmDescription) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: descriptionText(alarm.NewStateValue, alarm.AlarmDescription) },
    });
  }
  if (alarm.NewStateReason) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: safeText(alarm.NewStateReason, 500) }],
    });
  }
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `<${alarmConsoleUrl(alarmName, region)}|CloudWatch でアラームを開く>` },
    ],
  });

  return blocks;
}

/** Health イベントの種類。英語のコードだけでは伝わらないので日本語を添える */
const HEALTH_CATEGORY_LABEL: Record<string, string> = {
  issue: '障害',
  scheduledChange: '予定された変更',
  accountNotification: 'お知らせ',
  investigation: '調査中',
};

/** Health イベントの見出し（アイコンを除く）。無害化は使う側で行う */
function healthTitle(event: HealthEvent): string {
  return `AWS からの通知: ${event.detail?.service ?? '不明'}（${healthCategoryLabel(event)}）`;
}

function healthCategoryLabel(event: HealthEvent): string {
  const category = event.detail?.eventTypeCategory ?? '';
  return HEALTH_CATEGORY_LABEL[category] ?? category;
}

/**
 * AWS Health のイベントを組み立てる。
 * AWS 側の都合で起きる事象なので、こちらで直せるものではない。
 * 「何が・いつ・自分のどのリソースに影響するか」が分かることを優先する
 */
function buildHealthBlocks(event: HealthEvent): unknown[] {
  const detail = event.detail ?? {};
  const category = detail.eventTypeCategory ?? '';
  const categoryLabel = healthCategoryLabel(event);
  const service = detail.service ?? '不明';
  const icon = category === 'issue' ? '🔥' : category === 'scheduledChange' ? '🗓️' : 'ℹ️';

  const fields = [
    `*サービス*\n${safeText(service, 200)}`,
    `*種類*\n${safeText(categoryLabel, 100)}`,
    `*リージョン*\n${safeText(event.region ?? '不明', 100)}`,
    `*開始*\n${safeText(formatJst(detail.startTime ?? event.time), 100)}`,
  ];
  if (detail.endTime) {
    fields.push(`*終了*\n${safeText(formatJst(detail.endTime), 100)}`);
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        // plain_text は記法として解釈されないが、長さだけは抑えておく
        type: 'plain_text',
        text: clip(`${icon} ${healthTitle(event)}`, SLACK_HEADER_LIMIT),
        emoji: true,
      },
    },
    { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
  ];

  if (detail.eventTypeCode) {
    // バックティックが混ざるとコード表記が崩れるので落としておく
    const code = safeText(detail.eventTypeCode.replace(/`/g, "'"), 200);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `\`${code}\`` }],
    });
  }

  // 本文は英語で長いことがあるため、頭の方だけ載せて詳細はコンソールへ誘導する
  const description = detail.eventDescription?.[0]?.latestDescription;
  if (description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: safeText(description, 1500) },
    });
  }

  // 自分のどのリソースが対象かは、真っ先に知りたい情報。
  // ただし ARN は1件で最大2048文字あり、数件並べるだけで Slack の上限を超える。
  // 超えると送信そのものが失敗して通知が届かなくなるため、入る分だけ載せる
  const entities = (detail.affectedEntities ?? [])
    .map((e) => e.entityValue)
    .filter((v): v is string => !!v);
  if (entities.length > 0) {
    const budget = SLACK_TEXT_LIMIT - 100;
    const shown: string[] = [];
    let used = 0;
    for (const entity of entities) {
      const piece = escapeMrkdwn(entity);
      if (used + piece.length + 2 > budget) break;
      shown.push(piece);
      used += piece.length + 2;
    }
    const omitted = entities.length - shown.length;
    const rest = omitted > 0 ? ` ほか${omitted}件` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*影響を受けるリソース*\n${shown.join(', ')}${rest}` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '<https://health.aws.amazon.com/health/home|AWS Health Dashboard を開く>',
      },
    ],
  });

  return blocks;
}

/** アラーム形式でない通知（外形監視からの任意メッセージなど）はそのまま流す */
function buildPlainBlocks(subject: string | null | undefined, message: string): unknown[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: clip(subject ?? 'お知らせ', SLACK_HEADER_LIMIT), emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: safeText(message) },
    },
  ];
}

/**
 * SNS の 1 件から Slack に送る本文を組み立てる。
 *
 * text（通知プレビュー）は mrkdwn として扱われるので、ここで一度だけ無害化する。
 * 組み立て側で値を通し忘れても、記法や長すぎる文字がプレビューに漏れない
 */
export function buildSlackPayload(
  message: SnsMessage,
  sns: SnsEventRecord['Sns'],
  defaultRegion: string,
): SlackPayload {
  let blocks: unknown[];
  let fallbackText: string;
  switch (message.kind) {
    case 'health':
      blocks = buildHealthBlocks(message.event);
      fallbackText = healthTitle(message.event);
      break;
    case 'alarm':
      blocks = buildAlarmBlocks(message.alarm, sns.Timestamp, defaultRegion);
      fallbackText = headline(message.alarm.NewStateValue, message.alarm.AlarmName);
      break;
    default:
      return plainPayload(sns);
  }
  return { text: safeText(fallbackText, 200), blocks };
}

/** 件名と本文をそのまま流す本文。組み立てに失敗したときの代わりにも使う */
export function plainPayload(sns: SnsEventRecord['Sns']): SlackPayload {
  return {
    text: safeText(sns.Subject ?? 'お知らせ', 200),
    blocks: buildPlainBlocks(sns.Subject, sns.Message),
  };
}
