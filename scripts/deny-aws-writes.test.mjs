// deny-aws-writes.mjs の判定のテスト。依存を増やしたくないので node:test で書く。
// 実行は `node --test scripts/deny-aws-writes.test.mjs`。
// CI では .github/workflows/claude-hooks.yml が走らせる。
//
// 関数を import せず、フックと同じように子プロセスへ JSON を流し込んでいる。
// 「直接実行されたときだけ判定する」ガードを置くと、実行パスにシンボリックリンクが
// 挟まったときに判定ごと素通りするため、ガードを設けずに済む形にしてある。
//
// sakekasu-builder の PR #164 のセキュリティレビューで指摘されたバイパスの各形を、ここに固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./deny-aws-writes.mjs', import.meta.url));

function run(command) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `フックは常に 0 で終わる: ${result.stderr}`);
  return result.stdout;
}

const allows = (command) => assert.equal(run(command), '', `通るはず: ${command}`);
const denies = (command) => assert.match(
  run(command),
  /"permissionDecision":"deny"/,
  `止まるはず: ${command}`,
);

test('読み取り操作は通す', () => {
  allows('aws logs tail /aws/lambda/dev-sakekasu-health-check --since 30m');
  allows('aws logs tail /aws/lambda/x --follow --profile verify');
  allows('aws --profile verify logs tail /aws/lambda/x');
  allows('/usr/local/bin/aws logs tail /aws/lambda/x');
  allows('aws logs filter-log-events --log-group-name /aws/lambda/x');
  allows('aws sts get-caller-identity --profile verify');
  allows('aws logs start-query --profile verify');
  allows('aws s3 ls s3://bucket');
  allows('aws --version');
  allows('aws help');
});

test('変更操作は止める', () => {
  denies('aws logs delete-log-group --log-group-name /aws/lambda/x');
  denies('aws logs put-retention-policy --log-group-name x --retention-in-days 7');
  denies('aws lambda invoke --function-name x out.json');
  denies('aws sts assume-role --role-arn arn:aws:iam::1:role/x --role-session-name s');
  denies('aws ec2 run-instances --image-id ami-1');
});

test('名前が読み取りっぽくても実質が違うものは止める', () => {
  denies('aws ecs execute-command --command /bin/sh');
});

// SSO Portal API は SigV4 で署名されないので、verify セッションに重ねた Deny も
// ReadOnlyAccess の枠も効かない。get-role-credentials が通ると、その利用者に
// 割り当てられた任意のロールの一時認証情報が取れてしまう
test('sso は login 以外すべて止める', () => {
  denies('aws sso get-role-credentials --account-id 1 --role-name AdministratorAccess --access-token T');
  denies('aws --profile verify sso get-role-credentials --account-id 1 --role-name X --access-token T');
  denies('aws sso list-accounts --access-token T');
  denies('aws sso list-account-roles --access-token T --account-id 1');
  denies('aws sso logout');
  denies('aws sso-oidc create-token --client-id x --client-secret y --grant-type z');
  denies('aws sso-oidc start-device-authorization --client-id x --client-secret y --start-url u');
  allows('aws sso login --profile verify --use-device-code'); // 手順そのもの
});

// agent-toolkit も6操作すべてが署名されない。返るのは AWS 側のスキルカタログだが、
// IAM が一切届かないうえ確認作業では使わない
test('agent-toolkit は全部止める', () => {
  denies('aws agent-toolkit get-skill-file --skill-id x');
  denies('aws agent-toolkit get-skill --skill-id x');
  denies('aws agent-toolkit list-skills');
  denies('aws agent-toolkit search-skills --query test');
});

// Cognito の利用者向け操作も IAM で認証されない。deny ポリシーが止めているのは
// Admin* の側だけなので、こちらはこの関門でしか止まらない
test('IAM が届かない Cognito の操作は止める', () => {
  denies('aws cognito-identity get-credentials-for-identity --identity-id x');
  denies('aws cognito-identity get-id --identity-pool-id x');
  denies('aws cognito-identity get-open-id-token --identity-id x');
  denies('aws cognito-idp get-user --access-token T');
  denies('aws cognito-idp get-tokens-from-refresh-token --refresh-token R --client-id C');
  denies('aws cognito-idp list-devices --access-token T');
  denies('aws cognito-idp list-web-authn-credentials --access-token T');
  // IAM で認証される側は deny ポリシーの担当。ここでは止めない
  allows('aws cognito-idp describe-user-pool --user-pool-id x');
  allows('aws cognito-identity list-identity-pools --max-results 10');
});

// 資格情報そのものを返す操作。手に入れば以降は環境変数や SDK 経由になり、
// この関門からは見えなくなる
test('資格情報を返す操作は接頭辞が読み取りでも止める', () => {
  denies('aws sts get-session-token');
  denies('aws sts get-federation-token --name x --policy {}');
  denies('aws ecr get-login-password --region ap-northeast-1');
  denies('aws eks get-token --cluster-name x');
  denies('aws codeartifact get-authorization-token --domain d');
  allows('aws sts get-caller-identity'); // 素性を見るだけ
});

test('s3 の高レベルコマンドは ls だけを通す', () => {
  denies('aws s3 cp local.txt s3://bucket/');
  denies('aws s3 sync . s3://bucket/');
  denies('aws s3 mv a s3://bucket/b');
});

test('読み取り操作に似た綴りは通さない', () => {
  denies('aws logs tail-something');
  denies('aws tail');
});

// 区切り文字が直前の引数と融合していても、2 つ目の呼び出しを見つけられること
test('区切り文字が空白で挟まれていなくても後続の呼び出しを見る', () => {
  const write = 'logs delete-log-group --log-group-name y';
  denies(`aws logs tail /my-group;aws ${write}`);
  denies(`aws logs tail /g --follow;aws ${write}`);
  denies(`aws logs tail /g --follow&&aws ${write}`);
  denies(`aws logs tail /g||aws ${write}`);
  denies(`aws logs tail /g&aws ${write}`);
  denies(`aws sts get-caller-identity;aws ${write}`);
  denies(`echo $(aws ${write})`);
  denies(`echo \`aws ${write}\``);
  denies('aws logs tail /g;aws ec2 terminate-instances --instance-ids i-0abc123');
});

test('空白で区切られた形も従来どおり見る', () => {
  denies('aws logs tail /g && aws logs delete-log-group --log-group-name y');
  denies('aws logs tail /g | aws logs put-retention-policy --log-group-name y');
});

// シェルは引用符をまたいだ断片を 1 語につなぐ。判定もそれに合わせること
test('語の途中や先頭に空の引用符を挟んでも見る', () => {
  denies('aws "logs" delete-log-group --log-group-name y');
  denies("aws 'logs' delete-log-group --log-group-name y");
  denies('aws ""s3api delete-object --bucket x --key y');
  denies("aws ''s3api delete-object --bucket x --key y");
  denies('aws "" s3api delete-object --bucket x --key y');
  denies('aws s""3api delete-object --bucket x --key y');
  denies('aws s3""api delete-object --bucket x --key y');
  denies("aws s''3api delete-object --bucket x --key y");
  denies('aws e""c2 terminate-instances --instance-ids i-0abc123');
  denies('aws i""am create-user --user-name x');
  denies('aws lo""gs delete-log-group --log-group-name y');
  denies('aws l""ambda invoke --function-name x out.json');
  denies('aws logs de""lete-log-group --log-group-name y');
});

// bash は引用や打ち消しでコマンド名そのものを隠せる。字面だけを見ると素通りする
test('引用や打ち消しでコマンド名を隠しても止める', () => {
  const write = 'logs delete-log-group --log-group-name y';
  denies(`$'\\x61\\x77\\x73' ${write}`); // ANSI-C 引用（16進）
  denies(`$'\\141\\167\\163' ${write}`); // 同（8進）
  denies(`$'\\u0061\\u0077\\u0073' ${write}`); // 同（Unicode）
  denies(`$"aws" ${write}`); // ロケール引用。翻訳が無ければそのまま aws になる
});

test('行継続で分けても止める', () => {
  denies('aws \\\nlogs delete-log-group --log-group-name y');
  denies('aws logs \\\ndelete-log-group --log-group-name y');
});

// 二重引用符の中でもコマンド置換は効く
test('二重引用符の中のコマンド置換も見る', () => {
  const write = 'logs delete-log-group --log-group-name y';
  denies(`echo "$(aws ${write})"`);
  denies(`echo "\`aws ${write}\`"`);
  denies(`MSG="$(aws ${write})" && echo done`);
});

test('読み取り操作は引用や行継続をまたいでも通す', () => {
  allows('echo "$(aws sts get-caller-identity)"');
  allows('aws logs tail \\\n/aws/lambda/x --since 30m');
});

// 置換のあとも元の引用が続いていること。引用の外に出たままにすると、
// 元の引用を閉じる " が開き側と見なされ、後ろのコマンドを丸ごと飲み込む
test('コマンド置換のあとに続く呼び出しを見落とさない', () => {
  denies('echo "$(aws sts get-caller-identity)" && aws s3 rm s3://b/k');
  denies('MSG="$(aws s3 ls)"; aws s3api delete-object --bucket x --key y');
  denies('x="`aws sts get-caller-identity`" && aws s3 cp local s3://b/');
  allows('echo "$(aws sts get-caller-identity)" && echo done');
  allows('MSG="$(aws logs describe-log-groups)" && echo "$MSG"');
});

// 判定が例外で落ちると終了コードが 1 になり、フックの異常として素通りする
test('読み切れないコマンドは拒否側に倒す', () => {
  denies("$'\\U00110000' aws s3api delete-object --bucket x --key y");
  // 範囲外の打ち消しでも例外にせず読み切る。aws 呼び出しが無ければ通してよい。
  // allows は終了コードが 0 であることも見るので、落ちれば失敗する
  allows("$'\\UFFFFFFFF' echo hello");
  denies("$'aws logs delete-log-group --log-group-name y"); // $' の閉じ忘れ
  denies('echo "unterminated'); // 二重引用符の閉じ忘れ
  denies('echo $(aws logs delete-log-group --log-group-name y'); // 置換の閉じ忘れ
});

// bash は NUL を語から取り除く（a$'\x00'b は ab という 1 語になる）。
// 残してしまうと名前の形から外れて素通りする
test('NUL でコマンド名やサービス名を割っても止める', () => {
  denies("aws $'logs\\x00' delete-log-group --log-group-name y");
  denies("aws $'s3\\x00' rm s3://bucket/key");
  denies("aws $'logs\\000' delete-log-group --log-group-name y"); // 8 進
  denies("aws $'lo\\x00gs' delete-log-group --log-group-name y"); // 語の途中
  denies("$'aws\\x00' logs delete-log-group --log-group-name y"); // コマンド名の位置
});

// 単独では字にならない文字は名前の形を崩す。AWS CLI 自身も弾く形だが、関門
// としては素通りさせない。範囲ではなく Unicode の分類で落としている
test('制御文字で名前を割っても止める', () => {
  const W = 'delete-log-group --log-group-name y';
  denies(`aws $'\\x01logs' ${W}`);
  denies(`aws $'\\alogs' ${W}`); // 名前付きの打ち消し（BEL）
  denies(`aws $'\\nlogs' ${W}`);
  denies(`aws $'\\tlogs' ${W}`);
  denies(`aws $'\\x7flogs' ${W}`); // DEL
  denies(`aws $'lo\\x01gs' ${W}`); // 語の途中
  denies(`$'\\x01aws' logs ${W}`); // コマンド名の位置
});

test('C1 やゼロ幅の文字で名前を割っても止める', () => {
  const W = 'delete-log-group --log-group-name y';
  // 見えない文字なので、テストでは符号位置で書く
  denies(`aws \u0080logs ${W}`); // C1 の先頭
  denies(`aws \u009flogs ${W}`); // C1 の末尾
  denies(`\u0080aws logs ${W}`); // コマンド名の位置
  denies(`aws \u200blogs ${W}`); // ゼロ幅スペース
  denies(`aws \u00adlogs ${W}`); // ソフトハイフン
  denies(`aws lo\u2060gs ${W}`); // ワードジョイナ（語の途中）
  denies(`aws \ufefflogs ${W}`); // BOM
});

// 私用領域は表示のされ方が決まっておらず、孤立サロゲートは文字を成さない。
// どちらも単独では字にならないので、結合文字と同じ扱いで落とす
test('私用領域や孤立サロゲートで名前を割っても止める', () => {
  const W = 'delete-log-group --log-group-name y';
  denies(`aws l\ue000ogs ${W}`); // 私用領域（語中）
  denies(`\ue000aws logs ${W}`); // コマンド名の位置
  denies(`aws l\ud800ogs ${W}`); // 孤立サロゲート
});

// 名前の位置は、非 ASCII を落とすと名前になるならその名前として判定する。
// 分類ごとの継ぎ足しでは追いつかないので、まとめて閉じている
test('非ASCIIを混ぜて名前を隠しても止める', () => {
  const W = 'delete-log-group --log-group-name y';
  denies(`aws l\ufffeogs ${W}`); // 非文字 U+FFFE
  denies(`aws l\ufdd0ogs ${W}`); // 非文字 U+FDD0
  denies(`aws l\ufffdogs ${W}`); // 置換文字 U+FFFD
  denies(`aws l\u02b0ogs ${W}`); // 修飾文字（Lm）
  denies(`aws l\u043egs ${W}`); // キリル文字の о（同形異字）
  denies(`aws lo\u{1f600}gs ${W}`); // 絵文字
});

// コマンド名の位置はパスでも書ける。そちらにも混ぜ物を置けるので同じように読む
test('パスの形のコマンド名に混ぜ物があっても止める', () => {
  const W = 'logs delete-log-group --log-group-name y';
  denies(`/usr/local/bin/aws\u02b0 ${W}`); // 末尾に修飾文字
  denies(`/usr/local/bin/aws\u043e ${W}`); // 末尾にキリル文字
  denies(`/usr/local/bin/\u02b0aws ${W}`); // 直前に混ぜ物
  allows('/usr/local/bin/aws logs tail /aws/lambda/x'); // 読み取りは通る
});

// 実体を別名で置いて呼ぶ形は、名前を手がかりにする方式では追えない。
// 本当の境界は verify プロファイルの IAM 側にある
test('別名で置いた実体は追えない（既知の限界）', () => {
  allows('/tmp/x logs delete-log-group --log-group-name y');
});
// 落として空になる語は名前ではない。日本語の散文を止めないための境目
test('日本語の散文は呼び出しと見なさない', () => {
  allows('echo クラウドには aws が入っていないため手で入れる');
  allows('echo aws の導入手順を書き直す');
  allows('git commit -m "aws logs の設定を見直す"');
});

// ASCII の記号は引数として正当に使われるので落とさない。落とすと
// /usr/local/bin/aws_completer や scripts/ が名前に化けて誤検知する
test('ASCII の記号を含む引数は名前に化けない', () => {
  allows('rm -f /usr/local/bin/aws /usr/local/bin/aws_completer');
  allows('grep -rn "aws" scripts/');
});
// 結合文字はそれ自体では字にならず前の字を飾るだけなので、名前の一部になり得ない
test('結合文字で名前を飾っても止める', () => {
  const W = 'delete-log-group --log-group-name y';
  denies(`aws l\u0300ogs ${W}`); // 結合グレーブアクセント（語中）
  denies(`aws \u0301logs ${W}`); // 結合アキュートアクセント（先頭）
  denies(`\u0301aws logs ${W}`); // コマンド名の位置
});

// sso login は CLAUDE.md の確認手順そのものなので通す。logout は手順で使わず、
// トークンを失効させると確認作業ごと止まるため通さない
test('sso はログインだけ通す', () => {
  allows('aws sso login --profile verify --use-device-code');
  denies('aws sso logout --profile verify');
});

// start-query と start-live-tail は AWS 自身が読み取り専用の管理ポリシー
// CloudWatchLogsReadOnlyAccess に入れており、作るのは自分のクエリ・自分の
// ストリームだけ。stop-query は他人が始めたクエリも止められるので通さない
test('Logs Insights は自分の状態を作る操作だけ通す', () => {
  allows('aws logs start-query --profile verify');
  allows('aws logs start-live-tail --log-group-identifiers x');
  allows('aws logs describe-queries');
  denies('aws logs stop-query --query-id x');
});

// バッククォートの中の \` は閉じではない。bash は打ち消しを外してから中身を
// 実行するので、外した形で読み直さないと入れ子の呼び出しを見落とす
test('打ち消したバッククォートの内側も見る', () => {
  denies('echo "`x\\`aws s3 rm s3://bucket/key\\`done`"');
  denies('echo `x\\`aws s3 rm s3://bucket/key\\`done`');
  denies('echo "`echo \\`aws s3 rm s3://bucket/key\\``"');
});

test('通常の引用は誤検知しない', () => {
  allows("echo \"it's fine\"");
  allows("awk '{print $1}' file.txt");
  allows('for f in *.ts; do echo "$f"; done');
  allows('echo `date`');
  allows('bash -c "npm test"');
});

test('変数展開でサービス名を隠しても止める', () => {
  denies('aws $SERVICE delete-object --bucket x --key y');
  denies('aws ${SERVICE} delete-object --bucket x --key y');
});

// ここから下は誤検知側。散文やパスを呼び出しと読み違えないこと
test('散文に混じった aws は呼び出しと見なさない', () => {
  allows('git commit -m "aws の導入手順を書き直す"');
  allows('echo クラウドには aws が入っていないため手で入れる');
});

test('引数として渡されたパスは呼び出しと見なさない', () => {
  allows('rm -f /usr/local/bin/aws /usr/local/bin/aws_completer');
  allows('ls -la /usr/local/bin/aws');
});

test('aws を含む無関係なコマンドは通す', () => {
  allows('npm run build');
  allows('grep -rn "aws" scripts/');
});

test('引用符で囲った引数の中の区切り文字は区切りにしない', () => {
  allows('aws logs filter-log-events --filter-pattern "a;b" --log-group-name x');
});

test('壊れた入力では判定しない', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
