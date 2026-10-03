import { describe, expect, it } from 'vitest';
import { APP_PREFIXES, UNKNOWN_APP, appForAlarm } from '../app-label';

describe('アラーム名からアプリを引く', () => {
  it.each([
    // builder: {env}-sakekasu-*
    ['dev-sakekasu-slack-notifier-failure', 'builder'],
    ['prod-sakekasu-health-check-frontend', 'builder'],
    // learning: リソース名は {env}-sakekasu-learning-*。builder の接頭辞より長いので先に当たる
    ['dev-sakekasu-learning-api-errors', 'learning'],
    ['prod-sakekasu-learning-agent-errors', 'learning'],
    ['sakekasu-learning-dev-backend-errors', 'learning'],
    // kakeibo: sakekasu-kakeibo-{env}-*
    ['sakekasu-kakeibo-prod-api-errors', 'kakeibo'],
    // reinvent: ReinventPlanner*
    ['ReinventPlanner-ApiErrors', 'reinvent'],
    ['ReinventPlannerCertificate-x', 'reinvent'],
    // 共通基盤
    ['sakekasu-integrated-health-check-auth', '共通基盤'],
  ])('%s → %s', (alarmName, app) => {
    expect(appForAlarm(alarmName)).toBe(app);
  });

  it('どれにも当たらなければ「不明なアプリ」', () => {
    expect(appForAlarm('my-alarm')).toBe(UNKNOWN_APP);
    expect(appForAlarm('')).toBe(UNKNOWN_APP);
    // 大文字小文字は区別する（接頭辞はアプリ側の命名どおりに書く）
    expect(appForAlarm('reinventplanner-x')).toBe(UNKNOWN_APP);
  });

  // 長い接頭辞を先に見ないと、learning が builder と出る
  it('短い接頭辞が長い接頭辞の頭に含まれていても、長い方が勝つ', () => {
    for (const a of APP_PREFIXES) {
      for (const b of APP_PREFIXES) {
        if (a !== b && b.prefix.startsWith(a.prefix)) {
          expect(appForAlarm(`${b.prefix}x`), `${b.prefix} は ${a.prefix} より優先`).toBe(b.app);
        }
      }
    }
  });

  it('接頭辞に重複が無い', () => {
    const prefixes = APP_PREFIXES.map((p) => p.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
