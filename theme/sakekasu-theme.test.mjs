// theme/sakekasu-theme.css のテスト。node の標準モジュールだけで動かす。
//
//   node --test theme/sakekasu-theme.test.mjs
//
// 確かめること
//   - 色は :root の 1 か所だけに書き、ほかのブロックでは --sk-* を書かないこと
//   - 色の値がライトとダークのどちらでも 16 進 6 桁に解けること
//   - 文字と地の組み合わせが WCAG 2 の AA（本文 4.5:1、フォーカスの枠 3:1）を満たすこと

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sakekasu-theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

// :root { ... } の --sk-* の宣言を表にする（入れ子は扱わない）
const start = css.indexOf(':root {');
assert.notEqual(start, -1, ':root のブロックが無い');
const rootBody = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
const declared = {};
for (const [, name, value] of rootBody.matchAll(/(--sk-[\w-]+)\s*:\s*([^;]+);/g)) {
  declared[name] = value.replace(/\s+/g, ' ').trim();
}

// light-dark() の引数を、括弧の外のカンマで 2 つに分ける
function splitArgs(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '(') depth++;
    else if (args[i] === ')') depth--;
    else if (args[i] === ',' && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
  }
  assert.fail(`light-dark() の引数が 2 つではない: ${args}`);
}

/** 値を 16 進 6 桁の色に解く。色でなければ null */
function resolve(value, mode, seen = []) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const ref = /^var\((--sk-[\w-]+)\)$/.exec(value);
  if (ref) {
    assert.ok(!seen.includes(ref[1]), `var() が循環している: ${[...seen, ref[1]].join(' → ')}`);
    assert.ok(ref[1] in declared, `${ref[1]} が :root に無い`);
    return resolve(declared[ref[1]], mode, [...seen, ref[1]]);
  }
  const ld = /^light-dark\((.*)\)$/.exec(value);
  if (ld) return resolve(splitArgs(ld[1])[mode === 'light' ? 0 : 1], mode, seen);
  return null;
}

function palette(mode) {
  const vars = {};
  for (const [name, value] of Object.entries(declared)) {
    const hex = resolve(value, mode);
    if (hex) vars[name] = hex;
  }
  return vars;
}

const light = palette('light');
const dark = palette('dark');

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

test('--sk-* は :root の 1 か所だけに書く', () => {
  const outside = css.slice(0, start) + css.slice(css.indexOf('}', start) + 1);
  assert.deepEqual(outside.match(/--sk-[\w-]+\s*:/g) ?? [], []);
});

test('フォント以外の --sk-* は、ライトでもダークでも色に解ける', () => {
  const unresolved = Object.keys(declared).filter(
    (name) => !name.startsWith('--sk-font-') && !(light[name] && dark[name]),
  );
  assert.deepEqual(unresolved, []);
});

test('data-theme は color-scheme だけを切り替える', () => {
  assert.match(css, /:root\[data-theme='light'\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(css, /:root\[data-theme='dark'\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
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
