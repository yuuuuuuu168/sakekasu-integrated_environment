import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHealthChecks } from '../lib/health-checks';

const valid = { name: 'builder', url: 'https://sakekasu-builder.com/', expectStatus: [200] };

describe('parseHealthChecks', () => {
  it('cdk.json の healthChecks をそのまま通す', () => {
    const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8'));
    const targets = parseHealthChecks(cdkJson.context.healthChecks);
    // 4 アプリと共通ログイン
    expect(targets.map((t) => t.name)).toEqual(
      expect.arrayContaining(['builder', 'kakeibo', 'learning', 'reinvent', 'auth']),
    );
  });

  it('method と expectStatus を省けば GET と 200', () => {
    expect(parseHealthChecks([{ name: 'a', url: 'https://example.com/' }])).toEqual([
      { name: 'a', url: 'https://example.com/', method: 'GET', expectStatus: [200] },
    ]);
  });

  it('HEAD と複数のステータスを受け付ける', () => {
    const [t] = parseHealthChecks([{ ...valid, method: 'HEAD', expectStatus: [200, 204] }]);
    expect(t.method).toBe('HEAD');
    expect(t.expectStatus).toEqual([200, 204]);
  });

  it.each([
    ['配列でない', { name: 'a' }],
    ['空の配列', []],
    ['undefined', undefined],
  ])('%s は弾く', (_label, value) => {
    expect(() => parseHealthChecks(value)).toThrow(/1 つ以上/);
  });

  it.each([
    ['大文字', 'Builder'],
    ['空', ''],
    ['記号', 'a_b'],
    ['数字始まり', '1site'],
    ['長すぎる', 'a'.repeat(41)],
  ])('名前が%sなら弾く（アラーム名に入るため）', (_label, name) => {
    expect(() => parseHealthChecks([{ ...valid, name }])).toThrow(/name/);
  });

  it('名前の重複を弾く', () => {
    expect(() => parseHealthChecks([valid, { ...valid }])).toThrow(/重複/);
  });

  it.each([
    ['http', 'http://example.com/'],
    ['URL でない', 'example.com'],
    ['認証情報入り', 'https://user:pass@example.com/'],
    ['# 入り', 'https://example.com/#x'],
  ])('URL が%sなら弾く', (_label, url) => {
    expect(() => parseHealthChecks([{ ...valid, url }])).toThrow(/url/);
  });

  it('POST などは受け付けない（本文を送る監視はしない）', () => {
    expect(() => parseHealthChecks([{ ...valid, method: 'POST' }])).toThrow(/method/);
  });

  it.each([
    ['空', []],
    ['範囲外', [600]],
    ['小数', [200.5]],
    ['文字列', ['200']],
  ])('expectStatus が%sなら弾く', (_label, expectStatus) => {
    expect(() => parseHealthChecks([{ ...valid, expectStatus }])).toThrow(/expectStatus/);
  });

  it('知らない項目は弾く（書き間違いに気づけるように）', () => {
    expect(() => parseHealthChecks([{ ...valid, expectStatuses: [200] }])).toThrow(/知らない項目/);
  });

  it('オブジェクトでない要素は弾く', () => {
    expect(() => parseHealthChecks(['https://example.com/'])).toThrow(/オブジェクト/);
  });
});
