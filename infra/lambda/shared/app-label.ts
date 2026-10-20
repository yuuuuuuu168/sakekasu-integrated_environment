import { PREFIX } from '../../lib/names';

/** 共通基盤（このリポジトリ）のアラームの表示 */
export const PLATFORM_APP = '共通基盤';

/**
 * アラーム名の接頭辞から、どのアプリのアラームかを引く対応表。
 *
 * 4 アプリのアラームが同じトピック・同じ Slack チャンネルに届くので、通知の頭に
 * アプリ名を出す。各アプリはアラーム名に自分の接頭辞を付ける約束にしている（docs/monitoring.md）。
 *
 * 照合は長い接頭辞から順に行う。`dev-sakekasu-` は builder の接頭辞だが、
 * learning のリソース名（`dev-sakekasu-learning-*`）もこれで始まるため、短い方を先に見ると
 * learning のアラームが builder と出てしまう。
 *
 * アプリを足したら、ここと docs/monitoring.md の表に足す。
 */
export const APP_PREFIXES: ReadonlyArray<{ prefix: string; app: string }> = [
  { prefix: `${PREFIX}-`, app: PLATFORM_APP },
  // kakeibo: リソース名・スタック名とも sakekasu-kakeibo-{env}-*
  { prefix: 'sakekasu-kakeibo-', app: 'kakeibo' },
  // learning: sakekasu-learning-{env}-*。2026-10 より前のアラームは {env}-sakekasu-learning-*
  { prefix: 'sakekasu-learning-', app: 'learning' },
  { prefix: 'dev-sakekasu-learning-', app: 'learning' },
  { prefix: 'staging-sakekasu-learning-', app: 'learning' },
  { prefix: 'prod-sakekasu-learning-', app: 'learning' },
  // reinvent: スタック名が ReinventPlanner*
  { prefix: 'ReinventPlanner', app: 'reinvent' },
  // builder: sakekasu-builder-{env}-*。2026-10 より前のアラームと、名前を変えていないリソースは {env}-sakekasu-*
  { prefix: 'sakekasu-builder-', app: 'builder' },
  { prefix: 'dev-sakekasu-', app: 'builder' },
  { prefix: 'staging-sakekasu-', app: 'builder' },
  { prefix: 'prod-sakekasu-', app: 'builder' },
];

/** 長い接頭辞から照合するために並べ替えたもの */
const BY_LENGTH = [...APP_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);

/** どの接頭辞にも当たらないときの表示 */
export const UNKNOWN_APP = '不明なアプリ';

/** アラーム名からアプリ名を引く */
export function appForAlarm(alarmName: string): string {
  return BY_LENGTH.find(({ prefix }) => alarmName.startsWith(prefix))?.app ?? UNKNOWN_APP;
}
