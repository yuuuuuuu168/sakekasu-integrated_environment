/**
 * 対になっていないサロゲート（壊れた文字）を落とす。
 *
 * 残したまま JSON にすると `\ud83d` のような不正な文字列になり、
 * Slack や Webhook に拒否されて通知そのものが失われる。
 * URL 生成でも `encodeURIComponent` が例外を投げるため、早い段階で落とす
 */
export function dropBrokenCharacters(text: string): string {
  let result = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    const isBroken = character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    if (!isBroken) result += character;
  }
  return result;
}

/**
 * 長い文字列を、省略記号を含めて limit に収まるよう切り詰める。
 *
 * 長さは UTF-16 の単位で数える（Slack の上限の数え方に合わせる）。ただし切る位置は
 * 文字単位で決める。単純に slice すると絵文字が分断され、壊れた片割れが新たに生まれる
 */
export function clipText(text: string, limit: number, ellipsis = '…'): string {
  // 元から壊れた文字が混ざっていることがあるので、まず取り除く
  const cleaned = dropBrokenCharacters(text);
  if (cleaned.length <= limit) return cleaned;

  let result = '';
  for (const character of cleaned) {
    // 省略記号の分を残しておく
    if (result.length + character.length > limit - ellipsis.length) break;
    result += character;
  }
  return `${result}${ellipsis}`;
}
