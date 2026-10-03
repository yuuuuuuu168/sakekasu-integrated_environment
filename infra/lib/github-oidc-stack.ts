import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { githubMainBranchPrincipal } from './github-principal';
import { DEPLOY_ROLE_NAME, PREFIX } from './names';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** 信頼する GitHub リポジトリ（owner/repo 形式） */
  repository: string;
}

/**
 * GitHub Actions が最初に引き受けるロール。作りは sakekasu-kakeibo に倣った。
 *
 * このロールの仕事は、cdkd 用ロールのスタック（CloudFormation）を入れることだけ。
 * 自分では何も作れず、CDK bootstrap の cdk-hnb659fds-* ロールへの AssumeRole と、
 * スタックの出力の読み取りだけを持つ。
 *
 * このスタックは Actions のデプロイ対象に含めない。自分自身のロールを自動更新して
 * 締め出す事故を避けるため、コンテキストフラグ付きの手動デプロイとする（Mac から一度だけ）。
 *
 *   npx cdk deploy sakekasu-integrated-github-oidc -c github-oidc=true
 */
export class GithubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: DEPLOY_ROLE_NAME,
      // IAM の description は ASCII + Latin-1 のみ。日本語を入れるとデプロイが 400 で落ちる
      description: 'CDK deploy from GitHub Actions (main branch only)',
      assumedBy: githubMainBranchPrincipal(this, props.repository),
    });

    // ロール名にリージョンが入るのでワイルドカードにしている
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:${this.partition}:cloudformation:*:${this.account}:stack/${PREFIX}-*/*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}
