/*
 * アラートのトピック（SNS）から Lambda に届くものの型と、本文の振り分け。
 * Slack 通知（slack-notifier）と DevOps Agent への転送（devops-agent-webhook）が同じトピックを
 * 購読しているので、本文の読み方はここ 1 か所にまとめる。
 */

export interface SnsEventRecord {
  Sns: {
    Subject?: string | null;
    Message: string;
    Timestamp: string;
  };
}

export interface SnsEvent {
  Records: SnsEventRecord[];
}

/** CloudWatch アラームが SNS に流す本文（使う項目だけ） */
export interface AlarmMessage {
  AlarmName: string;
  AlarmDescription?: string | null;
  NewStateValue?: string;
  OldStateValue?: string;
  NewStateReason?: string;
  StateChangeTime?: string;
  Region?: string;
  AWSAccountId?: string;
  Trigger?: {
    MetricName?: string;
    Namespace?: string;
    Threshold?: number;
    ComparisonOperator?: string;
    EvaluationPeriods?: number;
    Period?: number;
  };
}

/** AWS Health が EventBridge に流すイベント（使う項目だけ） */
export interface HealthEvent {
  source: 'aws.health';
  /** イベントが配信されたリージョン。障害が起きている場所とは限らない */
  region?: string;
  time?: string;
  detail?: {
    service?: string;
    eventArn?: string;
    /** 障害が起きているリージョン。イベントが配信されたリージョンとは別物 */
    eventRegion?: string;
    eventScopeCode?: string;
    eventTypeCode?: string;
    eventTypeCategory?: string;
    startTime?: string;
    endTime?: string;
    eventDescription?: { language?: string; latestDescription?: string }[];
    affectedEntities?: { entityValue?: string }[];
  };
}

/** SNS の本文を読んだ結果。アラームでも Health でもないもの（JSON でない本文を含む）は other */
export type SnsMessage =
  | { kind: 'health'; event: HealthEvent }
  | { kind: 'alarm'; alarm: AlarmMessage }
  | { kind: 'other' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * SNS の本文を読み、何が届いたかを振り分ける。
 *
 * アラーム名は文字列で、空でないものだけをアラームとみなす。数値などが入っていると
 * 組み立ての途中で例外になるため、ここで other に落としてそのまま流す側に回す
 */
export function parseSnsMessage(message: string): SnsMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { kind: 'other' };
  }
  if (!isObject(parsed)) return { kind: 'other' };
  if (parsed.source === 'aws.health') return { kind: 'health', event: parsed as unknown as HealthEvent };
  if (typeof parsed.AlarmName === 'string' && parsed.AlarmName !== '') {
    return { kind: 'alarm', alarm: parsed as unknown as AlarmMessage };
  }
  return { kind: 'other' };
}
