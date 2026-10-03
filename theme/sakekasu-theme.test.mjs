// theme/sakekasu-theme.css のテスト。node の標準モジュールだけで動かす。
//
//   node --test theme/sakekasu-theme.test.mjs
//
// 確かめること
//   - ダークの値を書いた 2 か所（OS がダーク / data-theme="dark"）が同じ中身であること
//   - ライトとダークで同じ変数がそろっていること
//   - 文字と地の組み合わせが WCAG 2 の AA（本文 4.5:1、フォーカスの枠 3:1）を満たすこと

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sakekasu-theme.css'), 'utf8');

// セレクタの直後の { ... } を取り出し、--sk-* の宣言を表にする（入れ子は扱わない）
function block(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} のブロックが無い`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const vars = {};
  for (const [, name, value] of css.slice(open + 1, close).matchAll(/(--sk-[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value.replace(/\s+/g, ' ').trim();
  }
  return vars;
}

const light = block(':root');
const darkMedia = block(":root:not([data-theme='light'])");
const darkForced = block(":root[data-theme='dark']");
const dark = { ...light, ...darkForced };

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `16 進 6 桁の色ではない: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [前景, 背景, 必要な比]
const PAIRS = [
  ['--sk-ink', '--sk-bg', 4.5],
  ['--sk-ink', '--sk-surface', 4.5],
  ['--sk-ink', '--sk-surface-2', 4.5],
  ['--sk-ink-2', '--sk-bg', 4.5],
  ['--sk-ink-2', '--sk-surface', 4.5],
  ['--sk-muted', '--sk-bg', 4.5],
  ['--sk-muted', '--sk-surface', 4.5],
  ['--sk-accent', '--sk-bg', 4.5],
  ['--sk-accent', '--sk-surface', 4.5],
  ['--sk-accent', '--sk-accent-weak', 4.5],
  ['--sk-accent-ink', '--sk-accent', 4.5],
  ['--sk-accent-ink', '--sk-accent-hover', 4.5],
  ['--sk-gold-ink', '--sk-bg', 4.5],
  ['--sk-gold-ink', '--sk-surface', 4.5],
  ['--sk-success', '--sk-bg', 4.5],
  ['--sk-success', '--sk-surface', 4.5],
  ['--sk-warning', '--sk-bg', 4.5],
  ['--sk-warning', '--sk-surface', 4.5],
  ['--sk-danger', '--sk-bg', 4.5],
  ['--sk-danger', '--sk-surface', 4.5],
  ['--sk-focus', '--sk-bg', 3],
  ['--sk-focus', '--sk-surface', 3],
];

test('ダークの値は OS 追従と data-theme="dark" で同じ', () => {
  assert.deepEqual(darkMedia, darkForced);
});

test('ダークで上書きする変数はライトにもある', () => {
  for (const name of Object.keys(darkForced)) {
    assert.ok(name in light, `${name} がライトに無い`);
  }
});

for (const [mode, vars] of [
  ['ライト', light],
  ['ダーク', dark],
]) {
  test(`${mode}の文字と地のコントラスト`, () => {
    const failures = [];
    for (const [fg, bg, min] of PAIRS) {
      assert.ok(vars[fg] && vars[bg], `${fg} か ${bg} が無い`);
      const ratio = contrast(vars[fg], vars[bg]);
      if (ratio < min) failures.push(`${fg} ${vars[fg]} / ${bg} ${vars[bg]} = ${ratio.toFixed(2)}（${min} 以上が要る）`);
    }
    assert.deepEqual(failures, []);
  });
}
