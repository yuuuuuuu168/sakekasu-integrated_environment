import { readFileSync } from 'node:fs';
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

  // 各アプリでサインアウトしたら入口の表紙（https://sakekasu-builder.com/）へ戻す。
  // Cognito は登録していない logout_uri を拒むので、4 アプリともここを許しておく
  it('cdk.json の 4 アプリは、サインアウト後に入口の表紙へ戻れる', () => {
    const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8'));
    const apps = parseApps(cdkJson.context.apps);
    for (const name of ['builder', 'kakeibo', 'learning', 'reinvent']) {
      const app = apps.find((a) => a.name === name);
      expect(app?.logoutUrls).toContain('https://sakekasu-builder.com/');
    }
  });
});
