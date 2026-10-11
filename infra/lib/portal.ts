import * as fs from 'node:fs';
import { readTheme, THEME_CSS_PATH, type ThemeColors } from './login-branding';

/** 入口に並べるアプリ。並びはこの順 */
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
const JA_SANS =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','YuGothic','Meiryo','Noto Sans JP','Noto Sans CJK JP','IPAGothic',sans-serif";
/** 見出しの明朝 */
const JA_SERIF = "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP','IPAMincho',serif";

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
  const names = ['bg', 'surface', 'border', 'ink', 'muted', 'accent', 'accent-ink', 'gold-line'];
  return names
    .map((name) => {
      if (!c[name]) throw new Error(`共通テーマに --sk-${name} が無い`);
      return `--${name}:#${c[name]}`;
    })
    .join(';');
}

/**
 * 入口の 2 枚のページ。CloudFront Functions が返す（apex-redirect-stack.ts）。
 *
 * - トップ（/）: 和モダンの表紙と「パスキーでログイン」。ボタンは /apps へ行き、関数が共通ログインへ送る
 * - 一覧（/apps）: 共通ログインから戻ったあとの 4 アプリのボタンとログアウト（/logout）
 *
 * 2 枚は CSS を共有する。関数のコードの大きさを抑えるため、ページは head・css・body に分けて持ち、
 * 関数の中でつなぐ（page()）。色は共通テーマから合成のたびに作り、ライト・ダークは OS に合わせる。
 * 外のファイルもスクリプトも使わない（CSP で閉じている）。青海波は CSS のグラデーションで描く。
 */
export interface PortalParts {
  head: string;
  css: string;
  top: string;
  apps: string;
}

export function buildPortalParts(theme: { light: ThemeColors; dark: ThemeColors }, apps = PORTAL_APPS): PortalParts {
  for (const app of apps) {
    if (new URL(app.url).protocol !== 'https:') throw new Error(`入口のリンクは https にする: ${app.url}`);
  }
  // 青海波。半円の重なりを 2 段ずらして並べる。線は金を薄く
  const wave = (bg: string) =>
    `radial-gradient(circle at 50% 100%,${bg} 18%,#${theme.light['gold-line']}40 19% 23%,${bg} 24% 40%,` +
    `#${theme.light['gold-line']}40 41% 45%,${bg} 46% 62%,#${theme.light['gold-line']}40 63% 67%,${bg} 68% 70%,transparent 71%)`;
  const css =
    `:root{color-scheme:light dark;${vars(theme.light)}}` +
    `@media (prefers-color-scheme:dark){:root{${vars(theme.dark)}}}` +
    '*{box-sizing:border-box}' +
    `body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:${JA_SANS}}` +
    'a{color:inherit;text-decoration:none}' +
    // 表紙
    '.cover{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem 1.5rem;position:relative;overflow:hidden}' +
    `.cover:before{content:"";position:absolute;inset:0 0 auto;height:42vh;background:${wave('var(--bg)')} 0 0/48px 24px,${wave('var(--bg)')} 24px 12px/48px 24px;` +
    '-webkit-mask:linear-gradient(#000,transparent);mask:linear-gradient(#000,transparent);z-index:0}' +
    '.cover>*{position:relative;z-index:1;animation:up .8s ease-out both}' +
    '.cover>:nth-child(2){animation-delay:.1s}.cover>:nth-child(3){animation-delay:.2s}.cover>:nth-child(n+4){animation-delay:.3s}' +
    '@keyframes up{from{opacity:0;transform:translateY(12px)}}' +
    '@media (prefers-reduced-motion:reduce){.cover>*{animation:none}}' +
    '.mark{font-size:3.5rem;line-height:1}' +
    `h1{font-family:${JA_SERIF};font-weight:600;letter-spacing:.12em;margin:.5rem 0 0}` +
    '.cover h1{font-size:2.5rem}' +
    '.rule{display:flex;align-items:center;gap:.75rem;width:min(16rem,70vw);margin:1rem 0;color:var(--gold-line)}' +
    '.rule:before,.rule:after{content:"";flex:1;border-top:1px solid var(--gold-line)}' +
    '.lead{margin:0 0 2.5rem;color:var(--muted);letter-spacing:.08em}' +
    '.btn{display:inline-block;padding:1rem 2.5rem;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-weight:700;letter-spacing:.06em;box-shadow:0 6px 20px #0003}' +
    '.btn:hover,.btn:focus-visible{filter:brightness(1.1);outline:none}' +
    '.note{margin:.75rem 0 2.5rem;font-size:.8rem;color:var(--muted)}' +
    '.chips{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem}' +
    '.chips li{padding:.3rem .8rem;border:1px solid var(--border);border-radius:999px;font-size:.8rem;color:var(--muted);background:var(--surface)}' +
    // 一覧
    '.list{max-width:30rem;margin:0 auto;padding:2rem 1rem 3rem}' +
    'header{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid var(--gold-line);padding-bottom:.5rem;margin-bottom:1.5rem}' +
    'header h1{font-size:1.5rem;margin:0}' +
    '.out{font-size:.85rem;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:.35rem .9rem}' +
    '.apps{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}' +
    '.apps a{display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:.75rem;background:var(--surface)}' +
    '.apps a:hover,.apps a:focus-visible,.out:hover,.out:focus-visible{border-color:var(--accent);outline:none}' +
    '.i{font-size:2rem;line-height:1}' +
    '.apps b{display:block;font-size:1.125rem;color:var(--accent)}' +
    'small{color:var(--muted)}';
  const head =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<meta name="apple-mobile-web-app-title" content="sakekasu">' +
    `<meta name="theme-color" content="#${theme.light.bg}" media="(prefers-color-scheme: light)">` +
    `<meta name="theme-color" content="#${theme.dark.bg}" media="(prefers-color-scheme: dark)">` +
    '<title>sakekasu</title>';
  const chips = apps.map((app) => `<li>${escapeHtml(app.icon)} ${escapeHtml(app.label)}</li>`).join('');
  const top =
    '<main class="cover"><div class="mark" aria-hidden="true">🍶</div><h1>sakekasu</h1>' +
    '<div class="rule" aria-hidden="true">◆</div><p class="lead">4 つのアプリの入口</p>' +
    '<a class="btn" href="/apps">パスキーでログイン</a><p class="note">共通ログインの画面へ移動します</p>' +
    `<ul class="chips">${chips}</ul></main>`;
  const items = apps
    .map((app) => {
      const host = new URL(app.url).host;
      return (
        `<li><a href="${escapeHtml(app.url)}"><span class="i" aria-hidden="true">${escapeHtml(app.icon)}</span>` +
        `<span><b>${escapeHtml(app.label)}</b><small>${escapeHtml(host)}</small></span></a></li>`
      );
    })
    .join('');
  const list =
    '<main class="list"><header><h1>sakekasu</h1><a class="out" href="/logout">ログアウト</a></header>' +
    `<ul class="apps">${items}</ul></main>`;
  return { head, css, top, apps: list };
}

/** 1 枚のページにつなぐ。関数の中の page() と同じつなぎ方（テストと見た目の確認に使う） */
export function renderPage(parts: PortalParts, which: 'top' | 'apps'): string {
  return `${parts.head}<style>${parts.css}</style></head><body>${parts[which]}</body></html>`;
}

export function portalPartsFromThemeFile(): PortalParts {
  return buildPortalParts(readTheme(fs.readFileSync(THEME_CSS_PATH, 'utf8')));
}
