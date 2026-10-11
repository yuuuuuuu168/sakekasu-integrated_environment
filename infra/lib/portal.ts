import * as fs from 'node:fs';
import { readTheme, THEME_CSS_PATH, type ThemeColors } from './login-branding';

/** 入口のページに並べるアプリ。並びはこの順 */
export interface PortalApp {
  /** 画面に出す名前 */
  label: string;
  /** 名前の前に出す絵文字 */
  icon: string;
  /** 開く URL（https のみ） */
  url: string;
}

export const PORTAL_APPS: PortalApp[] = [
  { label: '酒カス', icon: '🍶', url: 'https://sake.sakekasu-builder.com/' },
  { label: '家計簿', icon: '💰', url: 'https://kakeibo.sakekasu-builder.com/' },
  { label: 'learning', icon: '📚', url: 'https://learning.sakekasu-builder.com/' },
  { label: 're:Invent', icon: '☁️', url: 'https://reinvent.sakekasu-builder.com/' },
];

/** 日本語の字形のフォント。iPhone・Mac はヒラギノ、Windows は游ゴシックかメイリオ、それ以外は Noto や IPA */
const JA_FONTS =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','YuGothic','Meiryo','Noto Sans JP','Noto Sans CJK JP','IPAGothic',sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 使う色だけを CSS の変数にする。関数のコードは 10 KB までなので、テーマの CSS を丸ごとは載せない */
function vars(c: ThemeColors): string {
  const names = ['bg', 'surface', 'border', 'ink', 'muted', 'accent', 'gold-line'];
  return names
    .map((name) => {
      if (!c[name]) throw new Error(`共通テーマに --sk-${name} が無い`);
      return `--${name}:#${c[name]}`;
    })
    .join(';');
}

/**
 * 4 アプリへの入口のページ（sakekasu-builder.com/）。CloudFront Functions がそのまま返す。
 *
 * 色は 4 アプリと同じ共通テーマ（theme/sakekasu-theme.css）から合成のたびに作る。
 * ライト・ダークは OS の設定に合わせる。外のファイルは読まない（CSP で閉じている）。
 */
export function buildPortalHtml(theme: { light: ThemeColors; dark: ThemeColors }, apps = PORTAL_APPS): string {
  for (const app of apps) {
    if (!new URL(app.url).protocol.startsWith('https')) throw new Error(`入口のリンクは https にする: ${app.url}`);
  }
  const items = apps
    .map((app) => {
      const host = new URL(app.url).host;
      return (
        `<li><a href="${escapeHtml(app.url)}"><span class="i" aria-hidden="true">${escapeHtml(app.icon)}</span>` +
        `<span><b>${escapeHtml(app.label)}</b><small>${escapeHtml(host)}</small></span></a></li>`
      );
    })
    .join('');
  const css =
    `:root{color-scheme:light dark;${vars(theme.light)}}` +
    `@media (prefers-color-scheme:dark){:root{${vars(theme.dark)}}}` +
    '*{box-sizing:border-box}' +
    // 日本語のフォントを先に並べる。system-ui を前に置くと、中国語の字形のフォントが選ばれる環境がある
    `body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:${JA_FONTS}}` +
    'main{max-width:30rem;margin:0 auto;padding:3rem 1rem}' +
    'h1{margin:0 0 1.5rem;font-size:1.5rem;border-bottom:2px solid var(--gold-line);padding-bottom:.5rem}' +
    'ul{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}' +
    'a{display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:.75rem;background:var(--surface);color:inherit;text-decoration:none}' +
    'a:hover,a:focus-visible{border-color:var(--accent);outline:none}' +
    '.i{font-size:2rem;line-height:1}' +
    'b{display:block;font-size:1.125rem;color:var(--accent)}' +
    'small{color:var(--muted)}';
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<meta name="apple-mobile-web-app-title" content="sakekasu">' +
    `<meta name="theme-color" content="#${theme.light.bg}" media="(prefers-color-scheme: light)">` +
    `<meta name="theme-color" content="#${theme.dark.bg}" media="(prefers-color-scheme: dark)">` +
    `<title>sakekasu</title><style>${css}</style></head>` +
    `<body><main><h1>sakekasu</h1><ul>${items}</ul></main></body></html>`
  );
}

export function portalHtmlFromThemeFile(): string {
  return buildPortalHtml(readTheme(fs.readFileSync(THEME_CSS_PATH, 'utf8')));
}
