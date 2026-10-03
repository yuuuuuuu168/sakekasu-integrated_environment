import { describe, expect, it } from 'vitest';
import { parseApps } from '../lib/apps';

const ok = { name: 'kakeibo', callbackUrls: ['https://kakeibo.example.com/'], logoutUrls: ['https://kakeibo.example.com/'] };

describe('parseApps', () => {
  it('正しい設定はそのまま通す', () => {
    expect(parseApps([ok])).toEqual([ok]);
  });

  it('手元で動かすときの http://localhost は通す', () => {
    const local = { ...ok, callbackUrls: ['http://localhost:5173/'] };
    expect(parseApps([local])[0].callbackUrls).toEqual(['http://localhost:5173/']);
  });

  it('アプリが 1 つも無ければ止める', () => {
    expect(() => parseApps(undefined)).toThrow(/1 つ以上/);
    expect(() => parseApps([])).toThrow(/1 つ以上/);
  });

  it.each([
    ['http（localhost 以外）', 'http://kakeibo.example.com/'],
    ['javascript スキーム', 'javascript:alert(1)'],
    ['URL でない文字列', 'kakeibo'],
    ['フラグメント付き', 'https://kakeibo.example.com/#x'],
    ['認証情報付き', 'https://user:pass@kakeibo.example.com/'],
  ])('戻り先の URL が %s なら止める', (_, url) => {
    expect(() => parseApps([{ ...ok, callbackUrls: [url] }])).toThrow(/https か http:\/\/localhost/);
    expect(() => parseApps([{ ...ok, logoutUrls: [url] }])).toThrow(/https か http:\/\/localhost/);
  });

  it('名前の形式と重複を確かめる', () => {
    expect(() => parseApps([{ ...ok, name: 'Kakeibo' }])).toThrow(/英小文字/);
    expect(() => parseApps([ok, ok])).toThrow(/重複/);
  });

  it('URL の一覧が空なら止める', () => {
    expect(() => parseApps([{ ...ok, callbackUrls: [] }])).toThrow(/1 つ以上/);
  });
});
