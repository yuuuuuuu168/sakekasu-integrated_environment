import { describe, expect, it } from 'vitest';
import { parseSnsMessage } from '../sns';

describe('SNS の本文の振り分け', () => {
  it('AWS Health のイベント', () => {
    const message = JSON.stringify({ source: 'aws.health', detail: { service: 'S3' } });
    expect(parseSnsMessage(message)).toMatchObject({ kind: 'health', event: { detail: { service: 'S3' } } });
  });

  it('CloudWatch アラーム', () => {
    const message = JSON.stringify({ AlarmName: 'sakekasu-kakeibo-prod-api-errors', NewStateValue: 'ALARM' });
    expect(parseSnsMessage(message)).toMatchObject({
      kind: 'alarm',
      alarm: { AlarmName: 'sakekasu-kakeibo-prod-api-errors' },
    });
  });

  // アラーム名を文字列として扱えないものは、組み立ての途中で例外になる。
  // アラームとみなさず、件名と本文をそのまま流す側に回す
  it.each([
    ['JSON でない本文', 'これは JSON ではない'],
    ['JSON の配列', '[1, 2]'],
    ['JSON の null', 'null'],
    ['アラーム名が数値', JSON.stringify({ AlarmName: 123 })],
    ['アラーム名が空', JSON.stringify({ AlarmName: '' })],
    ['どちらでもないオブジェクト', JSON.stringify({ hello: 'world' })],
  ])('%s は other', (_label, message) => {
    expect(parseSnsMessage(message)).toEqual({ kind: 'other' });
  });
});
