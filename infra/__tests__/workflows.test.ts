import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CDKD_DEPLOY_ROLE_NAME, CDKD_DEPLOY_STACK_NAME, DEPLOY_REGIONS, DEPLOY_ROLE_NAME } from '../lib/names';

/**
 * deploy ワークフローは CDK の外にあり、ロール名・スタック名・リージョンを直接書いている。
 * names.ts の値を変えたときに、ワークフローだけ古いまま残らないよう突き合わせる
 */
const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('deploy ワークフローと names.ts', () => {
  it('引き受けるロールの名前が同じ', () => {
    expect(deployYml).toContain(`:role/${DEPLOY_ROLE_NAME}\n`);
    expect(deployYml).toContain(`:role/${CDKD_DEPLOY_ROLE_NAME}\n`);
  });

  it('CloudFormation で入れる cdkd 用ロールのスタック名が同じ', () => {
    expect(deployYml).toContain(`npx cdk deploy ${CDKD_DEPLOY_STACK_NAME} `);
  });

  it('cdkd のアセットの置き場所を、cdkd が触るリージョンのすべてで確かめる', () => {
    const loop = deployYml.match(/for region in ([^;]+);/);
    expect(loop, 'リージョンのループが見つからない').not.toBeNull();
    expect(loop![1].trim().split(/\s+/)).toEqual(DEPLOY_REGIONS);
  });
});
