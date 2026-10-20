import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { IncidentPayload } from '../index';

/**
 * SNS のアラームを DevOps Agent の調査依頼に組み立てる部分を検証する。
 * ハンドラは環境変数を要求するため、読み込み前に用意しておく。
 */
process.env.WEBHOOK_PARAMETER_NAME = '/sakekasu-integrated/devops-agent/webhook';
process.env.SELF_ALARM_NAME = 'sakekasu-integrated-devops-agent-webhook-failure';

/** SSM が返す中身。鍵の入れ替えを再現するためテストから差し替える */
const secretState = vi.hoisted(() => ({
  value: JSON.stringify({
    webhookUrl: 'https://event-ai.ap-northeast-1.api.aws/webhook/generic/test',
    signingSecret: 'secret',
  }),
}));
const DEFAULT_SECRET = secretState.value;

// Webhook の設定取得で AWS を呼びに行かせない
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = async () => ({ Parameter: { Value: secretState.value } });
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

const SNS_TIMESTAMP = '2026-08-09T03:00:00.000Z';

let mod: typeof import('../index');
/** ハンドラに1件流し、Webhook へ送られた本文とヘッダーを取り出す（送らなければ null） */
let forward: (message: string) => Promise<{ incident: IncidentPayload; headers: Record<string, string> } | null>;

beforeAll(async () => {
  mod = await import('../index');

  forward = async (message) => {
    let captured: { incident: IncidentPayload; headers: Record<string, string> } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      captured = { incident: JSON.parse(init.body) as IncidentPayload, headers: init.headers };
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    try {
      await mod.handler({
        Records: [{ Sns: { Message: message, Timestamp: SNS_TIMESTAMP } }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return captured;
  };
});

function alarmMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    AlarmName: 'sakekasu-builder-dev-appsync-5xx',
    AlarmDescription: 'GraphQL API がサーバエラーを返しています',
    NewStateValue: 'ALARM',
    OldStateValue: 'OK',
    NewStateReason: 'Threshold Crossed: 1 datapoint [7.0] was greater than the threshold (5.0).',
    StateChangeTime: '2026-08-09T02:59:30.000Z',
    Region: 'Asia Pacific (Tokyo)',
    AWSAccountId: '123456789012',
    Trigger: {
      MetricName: '5XXError',
      Namespace: 'AWS/AppSync',
      Threshold: 5,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    },
    ...overrides,
  });
}

function healthEvent(category: string, detailOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: 'aws.health',
    region: 'ap-northeast-1',
    time: '2026-08-09T02:50:00Z',
    detail: {
      service: 'DYNAMODB',
      eventArn: 'arn:aws:health:ap-northeast-1::event/DYNAMODB/AWS_DYNAMODB_OPERATIONAL_ISSUE/abc',
      eventTypeCode: 'AWS_DYNAMODB_OPERATIONAL_ISSUE',
      eventTypeCategory: category,
      startTime: '2026-08-09T02:45:00Z',
      eventDescription: [{ latestDescription: 'We are investigating increased error rates.' }],
      affectedEntities: [{ entityValue: 'dev-sakekasu-purchases' }],
      ...detailOverrides,
    },
  });
}

describe('CloudWatch アラームの転送', () => {
  it('発報したアラームを調査依頼に組み立てて送る', async () => {
    const sent = await forward(alarmMessage());

    expect(sent).not.toBeNull();
    expect(sent!.incident.eventType).toBe('incident');
    expect(sent!.incident.action).toBe('created');
    expect(sent!.incident.title).toBe('CloudWatch アラーム: sakekasu-builder-dev-appsync-5xx');
    // 発報の時刻はアラーム側のものを使う（SNS の受信時刻ではない）
    expect(sent!.incident.timestamp).toBe('2026-08-09T02:59:30.000Z');
    expect(sent!.incident.service).toBe('sakekasu-builder');
  });

  it('調査の材料になる情報を本文に入れる', async () => {
    const sent = await forward(alarmMessage());

    expect(sent!.incident.description).toContain('GraphQL API がサーバエラーを返しています');
    expect(sent!.incident.description).toContain('Threshold Crossed');
    expect(sent!.incident.description).toContain('AWS/AppSync / 5XXError');
    expect(sent!.incident.description).toContain('123456789012');
    // どのアプリか分からないと調査先を間違えるため必ず添える
    expect(sent!.incident.description).toContain('sakekasu の builder');
  });

  it('アプリをアラーム名の接頭辞から引き、サービス名と本文に出す', async () => {
    const cases = [
      ['sakekasu-kakeibo-dev-api-5xx', 'kakeibo', 'sakekasu-kakeibo'],
      ['sakekasu-learning-dev-agent-system-errors', 'learning', 'sakekasu-learning'],
      ['ReinventPlanner-sync-stopped', 'reinvent', 'sakekasu-reinvent'],
      ['dev-sakekasu-ocr-errors', 'builder', 'sakekasu-builder'],
    ] as const;
    for (const [alarmName, app, service] of cases) {
      const sent = await forward(alarmMessage({ AlarmName: alarmName }));
      expect(sent!.incident.service).toBe(service);
      expect(sent!.incident.description).toContain(`sakekasu の ${app}`);
      expect(sent!.incident.data).toMatchObject({ app });
    }
  });

  it('共通基盤と判別できないアラームは共通基盤のサービスとして送る', async () => {
    const platform = await forward(alarmMessage({ AlarmName: 'sakekasu-integrated-health-check-auth' }));
    expect(platform!.incident.service).toBe('sakekasu-integrated');

    const unknown = await forward(alarmMessage({ AlarmName: 'someone-elses-alarm' }));
    expect(unknown!.incident.service).toBe('sakekasu-integrated');
    expect(unknown!.incident.description).toContain('判別できませんでした');
  });

  it('元のイベントをそのまま添える', async () => {
    const sent = await forward(alarmMessage());

    expect(sent!.incident.data).toMatchObject({
      source: 'cloudwatch-alarm',
      app: 'builder',
      alarm: { AlarmName: 'sakekasu-builder-dev-appsync-5xx' },
    });
  });

  it('HMAC 署名とタイムスタンプを同じ値で送る', async () => {
    const sent = await forward(alarmMessage());
    const { headers, incident } = sent!;
    const timestamp = headers['x-amzn-event-timestamp'];

    expect(headers['Content-Type']).toBe('application/json');
    expect(timestamp).toBeTruthy();
    // 署名の対象は「そのヘッダーの時刻」と「実際に送った本文」
    expect(headers['x-amzn-event-signature']).toBe(
      mod.sign(timestamp, JSON.stringify(incident), 'secret'),
    );
  });

  it('復旧（OK）では調査を起こさない', async () => {
    const sent = await forward(alarmMessage({ NewStateValue: 'OK', OldStateValue: 'ALARM' }));

    expect(sent).toBeNull();
  });

  it('データ不足でも調査を起こさない', async () => {
    const sent = await forward(alarmMessage({ NewStateValue: 'INSUFFICIENT_DATA' }));

    expect(sent).toBeNull();
  });

  it('転送の失敗を転送し返さない（届かないことを届けようとしない）', async () => {
    const sent = await forward(
      alarmMessage({ AlarmName: 'sakekasu-integrated-devops-agent-webhook-failure' }),
    );

    expect(sent).toBeNull();
  });

  it('アラームでも Health イベントでもない本文は転送しない', async () => {
    expect(await forward(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  it('JSON でない本文は転送しない', async () => {
    expect(await forward('ただのお知らせです')).toBeNull();
  });

  it('状態が変わった時刻が無ければ SNS の受信時刻で代用する', async () => {
    const sent = await forward(alarmMessage({ StateChangeTime: undefined }));

    expect(sent!.incident.timestamp).toBe(SNS_TIMESTAMP);
  });
});

describe('AWS Health の転送', () => {
  it('障害イベントは調査に回す', async () => {
    const sent = await forward(healthEvent('issue'));

    expect(sent).not.toBeNull();
    expect(sent!.incident.title).toBe('AWS Health 障害: DYNAMODB');
    expect(sent!.incident.priority).toBe('HIGH');
    // アカウント全体の話なので、どれか 1 つのアプリには寄せない
    expect(sent!.incident.service).toBe('sakekasu-integrated');
    expect(sent!.incident.description).toContain('AWS_DYNAMODB_OPERATIONAL_ISSUE');
    expect(sent!.incident.description).toContain('dev-sakekasu-purchases');
    // イベント ARN はイベントごとに一意なので、そのまま識別子に使える
    expect(sent!.incident.incidentId).toContain('AWS_DYNAMODB_OPERATIONAL_ISSUE');
  });

  it('予定された変更では調査を起こさない', async () => {
    expect(await forward(healthEvent('scheduledChange'))).toBeNull();
  });

  it('RFC-1123 で届く startTime を ISO-8601 に直して送る', async () => {
    // AWS Health の時刻はこの形式で届く。そのまま渡すと受け取り側の解釈に委ねることになる
    const sent = await forward(healthEvent('issue', { startTime: 'Fri, 27 Jan 2023 06:02:51 GMT' }));

    expect(sent!.incident.timestamp).toBe('2023-01-27T06:02:51.000Z');
  });

  it('日時として読めない startTime はイベントの発生時刻で代用する', async () => {
    const sent = await forward(healthEvent('issue', { startTime: 'いつか' }));

    // event.time（2026-08-09T02:50:00Z）に落ちる。こちらも ISO に揃える
    expect(sent!.incident.timestamp).toBe('2026-08-09T02:50:00.000Z');
  });

  it('障害のリージョンは eventRegion を使う（配信元の region ではない）', async () => {
    // グローバルなサービスの障害は us-east-1 から転送されてくるため、
    // event.region を信じると「東京の障害」と読めてしまう
    const sent = await forward(healthEvent('issue', { service: 'CLOUDFRONT', eventRegion: 'global' }));

    expect(sent!.incident.description).toContain('global');
    expect(sent!.incident.description).not.toContain('ap-northeast-1');
  });

  it('eventRegion が無ければ配信元の region で代用する', async () => {
    const sent = await forward(healthEvent('issue'));

    expect(sent!.incident.description).toContain('ap-northeast-1');
  });
});

describe('priorityForAlarm', () => {
  // 名前は 2026-10-11 時点でアカウントにある実物のアラームから取っている
  it('利用者がサイトを使えない・ログインできない・API が 5xx のものは最優先にする', () => {
    expect(mod.priorityForAlarm('sakekasu-integrated-health-check-kakeibo')).toBe('CRITICAL');
    expect(mod.priorityForAlarm('sakekasu-integrated-health-check-auth-issuer')).toBe('CRITICAL');
    expect(mod.priorityForAlarm('sakekasu-builder-dev-health-check-frontend')).toBe('CRITICAL');
    expect(mod.priorityForAlarm('sakekasu-builder-dev-appsync-5xx')).toBe('CRITICAL');
    expect(mod.priorityForAlarm('sakekasu-kakeibo-dev-api-5xx')).toBe('CRITICAL');
    expect(mod.priorityForAlarm('sakekasu-learning-dev-api-5xx')).toBe('CRITICAL');
    expect(mod.priorityForAlarm('ReinventPlanner-api-5xx')).toBe('CRITICAL');
  });

  it('主要機能の故障と同期の停止は HIGH にする', () => {
    expect(mod.priorityForAlarm('sakekasu-builder-dev-sommelier-system-errors')).toBe('HIGH');
    expect(mod.priorityForAlarm('sakekasu-kakeibo-dev-ocr-receipt-errors')).toBe('HIGH');
    expect(mod.priorityForAlarm('sakekasu-learning-dev-agent-system-errors')).toBe('HIGH');
    expect(mod.priorityForAlarm('ReinventPlanner-sync-stopped')).toBe('HIGH');
    // ソムリエの Runtime の外形監視は、サイトそのものではないので CRITICAL にしない
    expect(mod.priorityForAlarm('sakekasu-builder-dev-health-check-sommelier-runtime')).toBe('HIGH');
  });

  it('利用者から見えない失敗と、代わりの経路で動いているものは MEDIUM にする', () => {
    expect(mod.priorityForAlarm('sakekasu-builder-dev-image-delete-fail')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('sakekasu-integrated-slack-notifier-failure')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('sakekasu-kakeibo-dev-ocr-receipt-fallbacks')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('sakekasu-learning-dev-agent-chat-fallbacks')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('ReinventPlanner-llm-fallbacks')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('sakekasu-learning-dev-agent-invocations-high')).toBe('MEDIUM');
  });

  it('監視の停止は名前に監視対象を含んでも MEDIUM にする（壊れているのは監視の側）', () => {
    // 名前に health-check を含むため、順に見ると「サイトが落ちた」で CRITICAL に上がってしまう
    expect(mod.priorityForAlarm('sakekasu-integrated-watcher-failure-health-check')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('sakekasu-integrated-watcher-silent-health-check')).toBe('MEDIUM');
    expect(mod.priorityForAlarm('sakekasu-builder-dev-watcher-silent-health-check')).toBe('MEDIUM');
  });

  it('表に無いアラームは HIGH に倒す（黙って埋もれさせない）', () => {
    expect(mod.priorityForAlarm('sakekasu-kakeibo-dev-unknown-alarm')).toBe('HIGH');
  });
});

describe('buildIncidentId', () => {
  it('同じ発報からは同じ識別子になる（再試行で調査が二重にならない）', async () => {
    const first = await forward(alarmMessage());
    const second = await forward(alarmMessage());

    expect(first!.incident.incidentId).toBe(second!.incident.incidentId);
  });

  it('2度目の発報は別の識別子になる（重複として捨てられない）', async () => {
    const first = await forward(alarmMessage());
    const second = await forward(alarmMessage({ StateChangeTime: '2026-08-09T05:00:00.000Z' }));

    expect(first!.incident.incidentId).not.toBe(second!.incident.incidentId);
  });

  it('英数と - _ . : 以外は落とし、長さも抑える', () => {
    expect(mod.buildIncidentId(['アラーム/名 前', '2026-08-09T03:00:00.000Z'])).toMatch(
      /^[A-Za-z0-9\-._:]+$/,
    );
    expect(mod.buildIncidentId(['x'.repeat(300)])).toHaveLength(200);
  });

  it('材料が空でも識別子は必ず返す', () => {
    expect(mod.buildIncidentId([undefined, ''])).toBe('unknown-incident');
  });
});

describe('sign', () => {
  it('タイムスタンプと本文を鍵で署名する（AWS のサンプルと同じ手順）', () => {
    // 手順: base64(HMAC-SHA256("<timestamp>:<payload>", secret))
    expect(mod.sign('2026-08-09T03:00:00.000Z', '{"a":1}', 'secret')).toBe(
      'Fy38bUSVU52r5+88o4qlmbopsNPQKO5lW7MBhjaUqiw=',
    );
  });

  it('本文が1文字でも変われば署名も変わる', () => {
    const a = mod.sign('2026-08-09T03:00:00.000Z', '{"a":1}', 'secret');
    const b = mod.sign('2026-08-09T03:00:00.000Z', '{"a":2}', 'secret');

    expect(a).not.toBe(b);
  });

  it('同じ本文でも時刻が違えば署名は変わる（再送を弾けるようにするため）', () => {
    const a = mod.sign('2026-08-09T03:00:00.000Z', '{"a":1}', 'secret');
    const b = mod.sign('2026-08-09T03:00:01.000Z', '{"a":1}', 'secret');

    expect(a).not.toBe(b);
  });
});

describe('Webhook が失敗したとき', () => {
  it('例外にして SNS の再試行とアラームに拾わせる', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
    try {
      await expect(
        mod.handler({ Records: [{ Sns: { Message: alarmMessage(), Timestamp: SNS_TIMESTAMP } }] }),
      ).rejects.toThrow('HTTP 500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('失敗の本文に Webhook の URL や鍵を残さない', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch;
    try {
      await expect(
        mod.handler({ Records: [{ Sns: { Message: alarmMessage(), Timestamp: SNS_TIMESTAMP } }] }),
      ).rejects.toThrow(/^(?!.*(event-ai\.ap-northeast-1\.api\.aws|secret)).*$/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('本文の長さ', () => {
  it('長すぎる自由記述は、省略の印を含めて上限に収める', () => {
    expect(mod.clip('あ'.repeat(10), 10)).toBe('あ'.repeat(10));
    expect(mod.clip('あ'.repeat(20), 10)).toBe(`${'あ'.repeat(3)}…（以下省略）`);
  });

  // 片割れのサロゲートが本文に入ると、JSON が不正になって Webhook に拒否される
  it('絵文字の途中では切らない', () => {
    const clipped = mod.clip('🚨'.repeat(10), 10);
    expect(clipped).toBe('🚨…（以下省略）');
    expect(() => encodeURIComponent(clipped)).not.toThrow();
  });

  it('アラームの説明文が長くても本文が際限なく膨らまない', async () => {
    // 本文を読むのはエージェント（LLM）なので、調査の指示を押しのけさせない
    const sent = await forward(
      alarmMessage({ AlarmDescription: 'x'.repeat(5000), NewStateReason: 'y'.repeat(5000) }),
    );

    expect(sent!.incident.description.length).toBeLessThanOrEqual(4100);
    expect(sent!.incident.description).toContain('（以下省略）');
    // 切るのは本文だけ。エージェントが自分で読み解く生データは残す
    expect((sent!.incident.data.alarm as { AlarmDescription: string }).AlarmDescription).toHaveLength(
      5000,
    );
  });

  it('見出しも切る（一覧と Slack の投稿に出るため）', async () => {
    const alarm = await forward(alarmMessage({ AlarmName: `dev-sakekasu-${'x'.repeat(500)}` }));
    expect(alarm!.incident.title.length).toBeLessThanOrEqual(210);

    const health = await forward(healthEvent('issue', { service: 'y'.repeat(500) }));
    expect(health!.incident.title.length).toBeLessThanOrEqual(210);
  });
});

describe('toIsoTimestamp', () => {
  it('RFC-1123 とオフセット付きの表記を ISO-8601 に揃える', () => {
    expect(mod.toIsoTimestamp('Fri, 27 Jan 2023 06:02:51 GMT')).toBe('2023-01-27T06:02:51.000Z');
    expect(mod.toIsoTimestamp('2026-08-09T08:00:00.000+0000')).toBe('2026-08-09T08:00:00.000Z');
  });

  it('日時として読めない値と空の値は undefined にする（呼び出し側の代替に任せる）', () => {
    expect(mod.toIsoTimestamp('いつか')).toBeUndefined();
    expect(mod.toIsoTimestamp(undefined)).toBeUndefined();
    expect(mod.toIsoTimestamp('')).toBeUndefined();
  });
});

describe('assertHttpsUrl', () => {
  it('https ならそのまま通す', () => {
    expect(mod.assertHttpsUrl('https://event-ai.ap-northeast-1.api.aws/webhook/generic/test')).toBe(
      'https://event-ai.ap-northeast-1.api.aws/webhook/generic/test',
    );
  });

  it('https 以外は送る前に弾く', () => {
    expect(() => mod.assertHttpsUrl('http://event-ai.ap-northeast-1.api.aws/webhook')).toThrow(/https/);
    expect(() => mod.assertHttpsUrl('file:///etc/passwd')).toThrow(/https/);
  });

  it('URL として読めない値も弾き、値そのものはメッセージに残さない', () => {
    expect(() => mod.assertHttpsUrl('だいたいこのへん')).toThrow(/URL として読めません/);
    expect(() => mod.assertHttpsUrl('だいたいこのへん')).not.toThrow(/だいたいこのへん/);
  });

  it('AWS の Webhook エンドポイントは通す', () => {
    // 実際の形は https://event-ai.<region>.api.aws/webhook/generic/<id>
    expect(() =>
      mod.assertHttpsUrl('https://event-ai.ap-northeast-1.api.aws/webhook/generic/abc123'),
    ).not.toThrow();
    expect(() =>
      mod.assertHttpsUrl('https://event-ai.us-east-1.api.aws/webhook/generic/abc123'),
    ).not.toThrow();
  });

  it('内部向けのアドレスは https でも弾く', () => {
    // 誤って内部のエンドポイントを登録したとき、アカウント ID やリソースの
    // ARN が入った調査の本文をそこへ投げ続けないようにする
    const internal = [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/webhook',
      'https://localhost/webhook',
      'https://10.0.0.5/webhook',
      'https://172.16.0.1/webhook',
      'https://192.168.1.1/webhook',
      'https://[::1]/webhook',
      'https://[fd00::1]/webhook',
      // fc00::/7 の前半。ULA は fd だけではない
      'https://[fc00::1]/webhook',
      // IPv4 射影の IPv6。URL の正規化で ::ffff:a9fe:a9fe になり、
      // 内部アドレスを1つずつ弾く書き方だとすり抜けていた
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:127.0.0.1]/webhook',
      // 6to4。内側に IPv4 を埋め込める
      'https://[2002:a9fe:a9fe::1]/webhook',
      // 10進数・8進数表記の IPv4
      'https://2130706433/webhook',
      'https://0177.0.0.1/webhook',
    ];

    for (const url of internal) {
      expect(() => mod.assertHttpsUrl(url), url).toThrow(/api\.aws のエンドポイント/);
    }
  });

  it('AWS 以外のドメインも弾く（許す形だけを通す）', () => {
    // 内部アドレスを塞いでも、任意の公開ドメインへ本文を送れては意味がない。
    // api.aws 配下は第三者が取得できないため、ここを通れば送り先は AWS に限られる
    expect(() => mod.assertHttpsUrl('https://attacker.example/collect')).toThrow(
      /api\.aws のエンドポイント/,
    );
    expect(() => mod.assertHttpsUrl('https://event-ai.ap-northeast-1.api.aws.evil.example/x')).toThrow(
      /api\.aws のエンドポイント/,
    );
  });
});

describe('転送のしかた', () => {
  it('リダイレクトは追わない（検証していない先へ本文を運ばない）', async () => {
    const captured: { redirect?: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { redirect?: string }) => {
      captured.push(init);
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    try {
      await mod.handler({
        Records: [{ Sns: { Message: alarmMessage(), Timestamp: SNS_TIMESTAMP } }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 転送先の検証は設定を読んだときの1回だけ。307/308 は POST と本文を保つため、
    // 追ってしまうと検証を通っていない先へ調査の本文が渡る
    expect(captured).toHaveLength(1);
    expect(captured[0]?.redirect).toBe('error');
  });
});

/**
 * 設定のキャッシュは実行環境をまたいで残るため、時計を進めて期限切れを起こす。
 * 実タイマーまで差し替えると fetch の中断制御に影響するので Date だけ偽装する
 */
describe('Webhook 設定のキャッシュ', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterAll(() => {
    vi.useRealTimers();
    secretState.value = DEFAULT_SECRET;
  });

  it('期限が切れるまでは読み直さず、切れたら新しい鍵で署名する', async () => {
    secretState.value = JSON.stringify({
      webhookUrl: 'https://event-ai.ap-northeast-1.api.aws/webhook/generic/test',
      signingSecret: 'rotated',
    });

    // 期限内は前の鍵のまま（発報のたびに SSM を叩かない）
    const during = await forward(alarmMessage());
    expect(during!.headers['x-amzn-event-signature']).toBe(
      mod.sign(
        during!.headers['x-amzn-event-timestamp'],
        JSON.stringify(during!.incident),
        'secret',
      ),
    );

    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    // 期限が切れたら読み直す。鍵を入れ替えたあと古い鍵で署名し続けない
    const after = await forward(alarmMessage());
    expect(after!.headers['x-amzn-event-signature']).toBe(
      mod.sign(
        after!.headers['x-amzn-event-timestamp'],
        JSON.stringify(after!.incident),
        'rotated',
      ),
    );
  });

  it('設定が JSON でないとき、中身をメッセージに載せない', async () => {
    secretState.value = 'https://event-ai.ap-northeast-1.api.aws/webhook/generic/test';
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    // JSON.parse の例外は読めなかった中身の先頭を載せるため、握らないと URL や鍵がログに出る
    const run = mod.handler({
      Records: [{ Sns: { Message: alarmMessage(), Timestamp: SNS_TIMESTAMP } }],
    });

    await expect(run).rejects.toThrow(/JSON として読めません/);
    await expect(run).rejects.toThrow(/^(?!.*event-ai\.ap-northeast-1\.api\.aws).*$/s);
  });
});
