import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Slack へ渡すブロックの組み立てを検証する。
 * ハンドラは環境変数を要求するため、読み込み前に用意しておく。
 */
process.env.WEBHOOK_PARAMETER_NAME = '/test/webhook';

// Webhook URL の取得で AWS を呼びに行かせない
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = async () => ({ Parameter: { Value: 'https://hooks.slack.example/test' } });
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

type Block = { type: string; text?: { text?: string }; fields?: { text: string }[] };

let buildBlocksForMessage: (message: string, subject?: string | null) => Promise<Block[]>;
/** Slack へ送る本文まるごと（プレビュー文 text を含む） */
let buildPayloadForMessage: (message: string, subject?: string | null) => Promise<string>;

beforeAll(async () => {
  // ハンドラは Slack へ送ってしまうため、送信部分だけ差し替えて中身を取り出す
  const mod = await import('../index');
  buildBlocksForMessage = async (message, subject = null) => {
    const captured: Block[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      captured.push(...(JSON.parse(init.body).blocks as Block[]));
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    try {
      await mod.handler({
        Records: [{ Sns: { Subject: subject, Message: message, Timestamp: '2026-08-06T00:00:00Z' } }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return captured;
  };

  buildPayloadForMessage = async (message, subject = null) => {
    let payload = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      payload = init.body;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    try {
      await mod.handler({
        Records: [{ Sns: { Subject: subject, Message: message, Timestamp: '2026-08-06T00:00:00Z' } }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return payload;
  };
});

/** ブロック全体を1つの文字列にして中身を調べる */
function flatten(blocks: Block[]): string {
  return JSON.stringify(blocks);
}

function healthMessage(detail: Record<string, unknown>): string {
  return JSON.stringify({ source: 'aws.health', region: 'ap-northeast-1', detail });
}

describe('Slack へ渡す文字列の無害化', () => {
  // mrkdwn は <URL|文字> をリンクとして解釈するため、そのまま流すと
  // 偽のリンクを通知に差し込まれる
  it('本文のリンク記法を無効にする', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'IAM',
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: '<https://example.com|ここをクリック>' }],
      }),
    );
    const text = flatten(blocks);
    expect(text).not.toContain('<https://example.com|');
    expect(text).toContain('&lt;https://example.com');
  });

  it('一斉メンションを無効にする', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'EC2',
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: '<!channel> 緊急です' }],
      }),
    );
    expect(flatten(blocks)).not.toContain('<!channel>');
  });

  it('影響リソースの値も無害化する', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'S3',
        eventTypeCategory: 'issue',
        affectedEntities: [{ entityValue: '<https://evil.example|bucket>' }],
      }),
    );
    expect(flatten(blocks)).not.toContain('<https://evil.example|');
  });

  it('アラーム以外の任意メッセージも無害化する', async () => {
    const blocks = await buildBlocksForMessage('<!here> <https://evil.example|クリック>');
    const text = flatten(blocks);
    expect(text).not.toContain('<!here>');
    expect(text).not.toContain('<https://evil.example|');
  });

  // CloudWatch アラームの説明文にも同じ処理を通す
  it('アラームの説明も無害化する', async () => {
    const blocks = await buildBlocksForMessage(
      JSON.stringify({
        AlarmName: 'test-alarm',
        NewStateValue: 'ALARM',
        AlarmDescription: '<https://evil.example|対処はこちら>',
      }),
    );
    expect(flatten(blocks)).not.toContain('<https://evil.example|');
  });
});

describe('Slack の文字数上限', () => {
  // 上限を超えると送信そのものが 400 で失敗し、通知が届かなくなる
  const SECTION_LIMIT = 3000;

  it('長い本文でも section の上限を超えない', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'RDS',
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: 'あ'.repeat(50_000) }],
      }),
    );
    for (const block of blocks) {
      if (block.text?.text) {
        expect(block.text.text.length).toBeLessThan(SECTION_LIMIT);
      }
    }
  });

  // ARN は1件で最大2048文字あり、数件並ぶだけで上限を超える
  it('長い ARN が並んでも上限を超えず、省略件数を添える', async () => {
    const longArn = (n: number) => `arn:aws:rds:ap-northeast-1:111122223333:db:${'x'.repeat(900)}${n}`;
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'RDS',
        eventTypeCategory: 'issue',
        affectedEntities: [1, 2, 3, 4, 5].map((n) => ({ entityValue: longArn(n) })),
      }),
    );

    const resourceBlock = blocks.find((b) => b.text?.text?.includes('影響を受けるリソース'));
    expect(resourceBlock).toBeDefined();
    expect(resourceBlock!.text!.text!.length).toBeLessThan(SECTION_LIMIT);
    expect(resourceBlock!.text!.text).toContain('ほか');
  });
});

// Slack は最上位の text をプレビューやプッシュ通知で mrkdwn として扱う。
// ブロック側だけ無害化しても、ここが素通しだと同じことが起きる
describe('通知プレビュー文（text フィールド）', () => {
  const evil = '<!channel> <https://evil.example|いますぐ確認>';

  it.each([
    ['アラーム名', JSON.stringify({ AlarmName: evil, NewStateValue: 'ALARM' })],
    ['アラームの状態', JSON.stringify({ AlarmName: 'ok', NewStateValue: evil })],
    ['Health のサービス名', JSON.stringify({ source: 'aws.health', detail: { service: evil, eventTypeCategory: 'issue' } })],
    ['Health の種類', JSON.stringify({ source: 'aws.health', detail: { service: 'S3', eventTypeCategory: evil } })],
    ['JSON でない本文', 'これは JSON ではない'],
  ])('%s から記法が漏れない', async (_label, message) => {
    const payload = await buildPayloadForMessage(message, evil);
    const text = JSON.parse(payload).text as string;
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<https://evil.example|');
  });

  it('件名（Subject）からも漏れない', async () => {
    const payload = await buildPayloadForMessage('ただの本文', evil);
    const text = JSON.parse(payload).text as string;
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<https://evil.example|');
  });
});

// 個別の組み立て箇所を1つ通し忘れても、送信の直前で必ず無害化される。
// 「うっかり漏らしても守られる」ことをここで担保する
describe('送信直前の砦', () => {
  it('プレビュー文は必ず無害化されてから送られる', async () => {
    const mod = await import('../index');
    let payload = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      payload = init.body;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    try {
      // 組み立て側を経由せず、生の文字列を直接渡す経路を模す
      await mod.handler({
        Records: [
          {
            Sns: {
              Subject: null,
              Message: JSON.stringify({
                AlarmName: 'x',
                NewStateValue: 'ALARM',
                // ここは組み立て時に safeText を通していない値として扱われる
                OldStateValue: '<!here>',
              }),
              Timestamp: '2026-08-06T00:00:00Z',
            },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const sent = JSON.parse(payload);
    // text（プレビュー）にも blocks にも記法が残らない
    expect(JSON.stringify(sent)).not.toContain('<!here>');
  });

  it('プレビュー文の長さも抑える', async () => {
    const payload = await buildPayloadForMessage(
      JSON.stringify({ AlarmName: 'あ'.repeat(5000), NewStateValue: 'ALARM' }),
    );
    const text = JSON.parse(payload).text as string;
    expect(text.length).toBeLessThanOrEqual(210);
  });
});

// 無害化を二度通すと &lt; が &amp;lt; になり、通知の文字が壊れる。
// 見出し（plain_text）は記法を解釈しないので、そもそも通してはいけない
describe('無害化のかけすぎで表示を壊さない', () => {
  it('プレビュー文に実体参照が二重に出ない', async () => {
    const payload = await buildPayloadForMessage(
      JSON.stringify({ AlarmName: 'cpu>90%', NewStateValue: 'ALARM' }),
    );
    const text = JSON.parse(payload).text as string;
    expect(text).toContain('cpu&gt;90%');
    expect(text).not.toContain('&amp;gt;');
  });

  it('見出しにはエスケープせず、そのままの文字を出す', async () => {
    const blocks = await buildBlocksForMessage(
      JSON.stringify({ AlarmName: 'prod<->staging', NewStateValue: 'ALARM' }),
    );
    const header = blocks.find((b) => b.type === 'header');
    // plain_text は実体参照を戻さないので、素の文字でなければ画面が壊れる
    expect(header!.text!.text).toContain('prod<->staging');
    expect(header!.text!.text).not.toContain('&lt;');
  });

  it('Health の見出しもそのままの文字を出す', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({ service: 'S3<>test', eventTypeCategory: 'issue' }),
    );
    const header = blocks.find((b) => b.type === 'header');
    expect(header!.text!.text).toContain('S3<>test');
    expect(header!.text!.text).not.toContain('&lt;');
  });

  it('mrkdwn 側は一度だけ無害化される', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'S3',
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: 'a & b <tag>' }],
      }),
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('a &amp; b &lt;tag&gt;');
    expect(text).not.toContain('&amp;amp;');
    expect(text).not.toContain('&amp;lt;');
  });
});

/**
 * サロゲートペアの片割れ（壊れた文字）が残っていないか。
 *
 * JSON 文字列にすると壊れた文字は "\\ud83d" という ASCII 列に変わり、
 * そのままでは見つけられない。実際の文字列に対して調べること
 */
function hasLoneSurrogate(text: string): boolean {
  return [...text].some((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdfff && ch.length === 1;
  });
}

/** ブロックや送信本文に含まれる文字列をすべて集める */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectStrings(v, out));
  }
  return out;
}

/** 実際の文字列に戻したうえで壊れがないか調べる */
function anyLoneSurrogate(value: unknown): boolean {
  return collectStrings(value).some(hasLoneSurrogate);
}

// 絵文字は2つ分の長さを持つため、単純に切ると途中で分断される。
// 壊れた片割れは JSON として不正で、Slack 側に拒否されうる
describe('長い文字を切るときに絵文字を壊さない', () => {
  it('アラーム名の途中に絵文字があっても壊れない', async () => {
    const payload = await buildPayloadForMessage(
      JSON.stringify({
        // clip(name, 200) は 199 文字目で切る。絵文字を 198 から置くと
        // ちょうど分断される（この値でないと壊れないことを確認済み）
        AlarmName: 'a'.repeat(198) + '🔥' + 'b'.repeat(50),
        NewStateValue: 'ALARM',
      }),
    );
    expect(anyLoneSurrogate(JSON.parse(payload))).toBe(false);
  });

  it('Health のサービス名が絵文字だらけでも壊れない', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({ service: '🔥'.repeat(200), eventTypeCategory: 'issue' }),
    );
    expect(anyLoneSurrogate(blocks)).toBe(false);
  });

  it('本文が絵文字だらけでも壊れない', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'S3',
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: '🍶'.repeat(3000) }],
      }),
    );
    expect(anyLoneSurrogate(blocks)).toBe(false);
  });

  // エスケープで文字数が増え、切る位置がずれて絵文字に当たる場合
  it('エスケープで長さが変わっても壊れない', async () => {
    const payload = await buildPayloadForMessage(
      JSON.stringify({
        // '<' は escapeMrkdwn で 4 文字（&lt;）になる。
        // 50 + 37*4 = 198 文字ぶんとなり、直後の絵文字が切り出し位置に重なる
        AlarmName: 'a'.repeat(50) + '<'.repeat(37) + '🔥' + 'b'.repeat(50),
        NewStateValue: 'ALARM',
      }),
    );
    expect(anyLoneSurrogate(JSON.parse(payload))).toBe(false);
  });

  it('切る必要がなければそのまま出す', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({ service: '🔥S3', eventTypeCategory: 'issue' }),
    );
    const header = blocks.find((b) => b.type === 'header');
    expect(header!.text!.text).toContain('🔥S3');
  });

  // 本文は 1500 で切るため、そこに絵文字を重ねる
  it('本文の切り出し位置に絵文字が来ても壊れない', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: 'S3',
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: 'a'.repeat(1498) + '🔥' + 'b'.repeat(50) }],
      }),
    );
    expect(anyLoneSurrogate(blocks)).toBe(false);
  });
});

// Slack の header は 150 文字まで。超えると送信ごと 400 で失敗し、
// 通知が届かなくなる（実際に踏んだ）
describe('見出しの長さ制限', () => {
  const HEADER_LIMIT = 150;

  it.each([
    ['アラーム', JSON.stringify({ AlarmName: 'あ'.repeat(500), NewStateValue: 'ALARM' })],
    ['Health', JSON.stringify({ source: 'aws.health', detail: { service: 'S'.repeat(500), eventTypeCategory: 'issue' } })],
    ['JSON でない本文', 'ただの本文'],
  ])('%s の見出しが上限を超えない', async (_label, message) => {
    const blocks = await buildBlocksForMessage(message, 'x'.repeat(500));
    const header = blocks.find((b) => b.type === 'header');
    expect(header).toBeDefined();
    expect(header!.text!.text!.length).toBeLessThanOrEqual(HEADER_LIMIT);
  });
});

// 切るときに壊さないだけでなく、元から壊れた文字が混ざっていても取り除く。
// 残ると JSON が不正になり、Slack に拒否されて通知が失われる
describe('元から壊れた文字が混ざっていても落とす', () => {
  const BROKEN = '\ud83d'; // 対になっていないサロゲート

  it('短い文字列でも取り除く（切る必要がない場合）', async () => {
    const payload = await buildPayloadForMessage(
      JSON.stringify({ AlarmName: `アラーム${BROKEN}名`, NewStateValue: 'ALARM' }),
    );
    // JSON の中に不正なエスケープ列が残らない
    expect(/\\ud[89ab][0-9a-f]{2}/i.test(payload)).toBe(false);
    expect(anyLoneSurrogate(JSON.parse(payload))).toBe(false);
  });

  it('Health のイベントでも取り除く', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({
        service: `S3${BROKEN}`,
        eventTypeCategory: 'issue',
        eventDescription: [{ latestDescription: `本文${BROKEN}です` }],
        affectedEntities: [{ entityValue: `bucket${BROKEN}` }],
      }),
    );
    expect(anyLoneSurrogate(blocks)).toBe(false);
  });

  // encodeURIComponent は壊れた文字で例外を投げる。
  // 送信前に落ちると通知そのものが失われる
  it('アラーム名が壊れていてもリンク生成で落ちない', async () => {
    const blocks = await buildBlocksForMessage(
      JSON.stringify({ AlarmName: `alarm${BROKEN}x`, NewStateValue: 'ALARM' }),
    );
    const link = collectStrings(blocks).find((t) => t.includes('CloudWatch でアラームを開く'));
    expect(link).toBeDefined();
    expect(anyLoneSurrogate(blocks)).toBe(false);
  });

  it('正常な絵文字は残す', async () => {
    const blocks = await buildBlocksForMessage(
      healthMessage({ service: '🍶S3', eventTypeCategory: 'issue' }),
    );
    expect(collectStrings(blocks).join('')).toContain('🍶S3');
  });
});

// Slack に流すだけだと、後から中身を AWS 側から追えない。
// Health API はサポート契約が要り、EventBridge もイベントを保存しないため、
// ここでログに残しておかないと Slack の画面が唯一の記録になる
describe('Health イベントをログに残す', () => {
  /** console.log に出た JSON のうち、Health イベントの行だけ拾う */
  async function capturedHealthLogs(message: string): Promise<Record<string, unknown>[]> {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await buildBlocksForMessage(message);
      return spy.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string')
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((parsed) => parsed.kind === 'aws-health-event');
    } finally {
      spy.mockRestore();
    }
  }

  // 2026-08-21 に実際に届いたもの
  const connectIssue = {
    service: 'CONNECT',
    eventArn: 'arn:aws:health:ap-northeast-1::event/CONNECT/AWS_CONNECT_OPERATIONAL_ISSUE/example',
    eventRegion: 'ap-northeast-1',
    eventScopeCode: 'PUBLIC',
    eventTypeCode: 'AWS_CONNECT_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    startTime: '2026-08-21T02:02:22Z',
    endTime: '2026-08-21T02:40:02Z',
    eventDescription: [{ latestDescription: '[RESOLVED] Increased Error Rates' }],
  };

  it('あとから追うのに要る項目が揃っている', async () => {
    const [logged] = await capturedHealthLogs(healthMessage(connectIssue));
    expect(logged).toMatchObject({
      service: 'CONNECT',
      eventTypeCode: 'AWS_CONNECT_OPERATIONAL_ISSUE',
      eventTypeCategory: 'issue',
      eventScopeCode: 'PUBLIC',
      eventRegion: 'ap-northeast-1',
      startTime: '2026-08-21T02:02:22Z',
      endTime: '2026-08-21T02:40:02Z',
      description: '[RESOLVED] Increased Error Rates',
    });
  });

  // 使っていないサービスの通知が届いたとき、PUBLIC か ACCOUNT_SPECIFIC かで
  // 「こちらのリソースの話か」がすぐ分かる
  it('リージョン全体の公開イベントかどうかが残る', async () => {
    const [logged] = await capturedHealthLogs(
      healthMessage({ ...connectIssue, eventScopeCode: 'ACCOUNT_SPECIFIC' }),
    );
    expect(logged.eventScopeCode).toBe('ACCOUNT_SPECIFIC');
  });

  // eventRegion がない古い形でも、配信先のリージョンで代替する
  it('eventRegion がなければ配信先のリージョンで補う', async () => {
    const { eventRegion: _omitted, ...withoutRegion } = connectIssue;
    const [logged] = await capturedHealthLogs(healthMessage(withoutRegion));
    expect(logged.eventRegion).toBe('ap-northeast-1');
  });

  it('影響を受けるリソースの件数が残る', async () => {
    const [logged] = await capturedHealthLogs(
      healthMessage({
        ...connectIssue,
        affectedEntities: [{ entityValue: 'arn:aws:x:::1' }, { entityValue: 'arn:aws:x:::2' }],
      }),
    );
    expect(logged.affectedEntityCount).toBe(2);
  });

  // CloudWatch Logs の1イベントには上限がある。
  // 本文は数千文字になることがあるため、丸ごとは載せない
  it('長い本文は切り詰める', async () => {
    const [logged] = await capturedHealthLogs(
      healthMessage({
        ...connectIssue,
        eventDescription: [{ latestDescription: 'あ'.repeat(5000) }],
      }),
    );
    expect((logged.description as string).length).toBeLessThanOrEqual(1000);
  });

  // アラームは CloudWatch のアラーム履歴に残るので、ここで重ねて出す必要はない
  it('アラームでは出さない', async () => {
    const logs = await capturedHealthLogs(
      JSON.stringify({ AlarmName: 'dev-sakekasu-ocr-errors', NewStateValue: 'ALARM' }),
    );
    expect(logs).toHaveLength(0);
  });

  // 記録を残すのが目的なので、Slack が落ちているときこそ残っていてほしい
  it('Slack への送信が失敗しても残る', async () => {
    const mod = await import('../index');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
    try {
      await expect(
        mod.handler({
          Records: [
            {
              Sns: {
                Subject: null,
                Message: healthMessage(connectIssue),
                Timestamp: '2026-08-21T02:02:22Z',
              },
            },
          ],
        }),
      ).rejects.toThrow();
      const logged = spy.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string')
        .filter((line) => line.includes('aws-health-event'));
      expect(logged).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      spy.mockRestore();
    }
  });
});

// 4 アプリのアラームが同じチャンネルに届くので、どのアプリのものかを出す
describe('アラームのアプリ名', () => {
  function alarm(name: string, state = 'ALARM'): string {
    return JSON.stringify({ AlarmName: name, NewStateValue: state, OldStateValue: 'OK' });
  }

  it.each([
    ['dev-sakekasu-ocr-errors', '[builder]'],
    ['dev-sakekasu-learning-api-errors', '[learning]'],
    ['sakekasu-kakeibo-prod-api-errors', '[kakeibo]'],
    ['ReinventPlanner-ApiErrors', '[reinvent]'],
    ['sakekasu-integrated-health-check-builder', '[共通基盤]'],
    ['someone-else-alarm', '[不明なアプリ]'],
  ])('%s の見出しに %s を出す', async (name, label) => {
    const blocks = await buildBlocksForMessage(alarm(name));
    const header = blocks.find((b) => b.type === 'header');
    expect(header!.text!.text).toContain(label);
    expect(header!.text!.text).toContain(name);
  });

  it('本文の欄にもアプリ名を出す', async () => {
    const blocks = await buildBlocksForMessage(alarm('dev-sakekasu-learning-api-errors'));
    const section = blocks.find((b) => b.fields);
    expect(section!.fields![0].text).toBe('*アプリ*\nlearning');
  });

  // プッシュ通知の 1 行目だけでも、どのアプリか分かるように
  it('通知プレビュー文にもアプリ名を出す', async () => {
    const payload = await buildPayloadForMessage(alarm('sakekasu-kakeibo-prod-api-errors'));
    expect(JSON.parse(payload).text).toContain('[kakeibo]');
  });

  // 発報だけでなく復旧も同じ形で届く
  it('復旧（OK）の通知にもアプリ名を出す', async () => {
    const blocks = await buildBlocksForMessage(alarm('ReinventPlanner-ApiErrors', 'OK'));
    const header = blocks.find((b) => b.type === 'header');
    expect(header!.text!.text).toBe('✅ [reinvent] 復旧しました: ReinventPlanner-ApiErrors');
  });

  it('AWS Health にはアプリ名を付けない（アカウント全体の話なので）', async () => {
    const blocks = await buildBlocksForMessage(
      JSON.stringify({ source: 'aws.health', detail: { service: 'LAMBDA', eventTypeCategory: 'issue' } }),
    );
    const header = blocks.find((b) => b.type === 'header');
    expect(header!.text!.text).not.toMatch(/\[.+\]/);
  });
});

// 説明（alarmDescription）は「鳴ったときの文」なので、復旧の通知で同じ見出しのまま出すと
// 異常が続いているように読める。ALARM 以外では、何を見ているアラームかの説明として出す
describe('アラームの説明の欄', () => {
  const DESCRIPTION = '外形監視で learning（https://learning.example）が期待した応答（200）を返していません';

  function alarm(newState: string, oldState: string): string {
    return JSON.stringify({
      AlarmName: 'sakekasu-integrated-health-check-learning',
      AlarmDescription: DESCRIPTION,
      NewStateValue: newState,
      OldStateValue: oldState,
    });
  }

  async function descriptionSection(message: string): Promise<string> {
    const blocks = await buildBlocksForMessage(message);
    const section = blocks.find((b) => b.type === 'section' && b.text?.text?.includes(DESCRIPTION));
    return section!.text!.text!;
  }

  it('ALARM のときは「内容」としてそのまま出す', async () => {
    expect(await descriptionSection(alarm('ALARM', 'OK'))).toBe(`*内容*\n${DESCRIPTION}`);
  });

  it('OK のときは「見ているもの」とし、今は解消していると前置きする', async () => {
    const text = await descriptionSection(alarm('OK', 'INSUFFICIENT_DATA'));
    expect(text).not.toContain('*内容*');
    expect(text).toBe(
      `*このアラームが見ているもの*\n次の状態になると鳴ります（今は解消しています）:\n${DESCRIPTION}`,
    );
  });

  it('INSUFFICIENT_DATA のときも「見ているもの」とし、判定できていないと前置きする', async () => {
    const text = await descriptionSection(alarm('INSUFFICIENT_DATA', 'OK'));
    expect(text).not.toContain('*内容*');
    expect(text.startsWith('*このアラームが見ているもの*\n')).toBe(true);
    expect(text).toContain('データが足りず判定できていません');
  });

  it('説明が無いアラームでは欄そのものを出さない', async () => {
    const blocks = await buildBlocksForMessage(
      JSON.stringify({ AlarmName: 'sakekasu-integrated-x', NewStateValue: 'OK', OldStateValue: 'ALARM' }),
    );
    expect(flatten(blocks)).not.toContain('このアラームが見ているもの');
    expect(flatten(blocks)).not.toContain('*内容*');
  });

  it('OK のときも説明は無害化して出す', async () => {
    const blocks = await buildBlocksForMessage(
      JSON.stringify({
        AlarmName: 'sakekasu-integrated-x',
        AlarmDescription: '<!channel> 説明',
        NewStateValue: 'OK',
        OldStateValue: 'ALARM',
      }),
    );
    expect(flatten(blocks)).toContain('&lt;!channel&gt; 説明');
    expect(flatten(blocks)).not.toContain('<!channel>');
  });
});
