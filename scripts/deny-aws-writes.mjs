// PreToolUse フックの判定本体。scripts/deny-aws-writes.sh から呼ばれる。
// stdin に Claude Code のフック入力 JSON を受け取り、拒否するときだけ
// permissionDecision: "deny" を stdout に出す（何も出さなければ通常の権限フロー）。
//
// 方式は許可リスト。読み取り操作だけを通し、それ以外の AWS CLI 操作は拒否する。
// 拒否リストだと invoke / assume-role / run-instances のように動詞が read でも
// write でもない操作を数え漏らすため。
//
// これはうっかり変更操作を打つのを止めるための関門であって、サンドボックスではない。
// コマンド文字列を読むだけなので、引用符の内側に隠した呼び出し（bash -c で渡すなど）、
// 変数展開、base64、SDK 経由の操作までは見えない。本当の境界は verify プロファイルが
// 参照する読み取り専用の Permission Set にあり、こちらはその手前の網。

// 値を取る AWS CLI のグローバルオプション。サービス名の手前で読み飛ばす
const FLAGS_WITH_VALUE = new Set([
  '--profile', '--region', '--output', '--endpoint-url', '--query', '--color',
  '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--cli-binary-format',
]);

// 読み取り操作の接頭辞
const READ_PREFIXES = [
  'get-', 'list-', 'describe-', 'batch-get-', 'head-', 'lookup-',
  'search-', 'select-', 'filter-', 'check-', 'validate-', 'simulate-', 'estimate-',
];

// 接頭辞では拾えない読み取り操作。
// 読み取りそうな名前でも実質は違うものがあるため、載せる前に実際の権限を確認する。
// 例えば ecs execute-command はコンテナ内でコマンドを実行するので、ここには載せない。
const READ_EXACT = new Set([
  // sso login は読み取りではないが、CLAUDE.md の確認手順そのもの
  // （aws sso login --profile verify --use-device-code）なので通す。人の承認を
  // 挟むデバイスコードフローで、作るのは自分のセッションだけ。
  // 対する sso logout は手順のどこでも使わないうえ、トークンを失効させると
  // そのセッションの確認作業ごと止まるため通さない
  'sso login',
  'configure list', 'configure list-profiles', 'configure get',
  // logs tail は高レベルコマンドで、内部は FilterLogEvents（--follow なら StartLiveTail）
  'logs tail',
  // この2つは名前が read らしくないが、AWS 自身が読み取り専用の管理ポリシー
  // CloudWatchLogsReadOnlyAccess に logs:StartQuery / StartLiveTail を入れている。
  // verify の土台は ReadOnlyAccess なので実際に許可される。どちらも作るのは
  // 自分のクエリ・自分のストリームだけで、他人の状態には触らない。
  // 対する stop-query は、describe-queries で拾った ID を指定すれば誰が始めた
  // クエリでも止められる。自分が始めたものを止める用途しか無いのに他人の状態へ
  // 届いてしまうので、載せない
  'logs start-query', 'logs start-live-tail',
  'dynamodb scan', 'dynamodb query',
  's3 ls',
]);

// 名前は読み取りの接頭辞だが、通してはいけない操作。READ_PREFIXES より先に見る。
//
// 一覧は CLI 同梱の botocore モデルから機械的に出した。SigV4 で署名されない
// （モデル上 authtype: none）操作を持つサービスは7つある。署名されない呼び出しには
// IAM の認可がかからないので、そこだけはこの関門が唯一の防ぎ手になる。
//
//   sso              4/4 が署名なし          → サービスごと落とす（下の isRead）
//   sso-oidc         3/4 が署名なし          → 同上。残り1つもトークンを作る側
//   agent-toolkit    6/6 が署名なし          → 同上
//   cognito-identity 4/23 が署名なし         → 署名なしの分だけ下に並べる
//   cognito-idp      32/129 が署名なし       → 同上
//   signin           1/11（create-o-auth2-token）
//   sts              2/11（assume-role-with-saml / -web-identity）
//
// signin と sts の署名なし操作、および cognito の署名なし操作の残り（delete-user や
// change-password など利用者データを書き換える側）は、名前が READ_PREFIXES に
// 当たらないので既に落ちている。ここに並べるのは接頭辞で通ってしまう分だけ。
//
// サービス名は CLI から見た名前で書く。モデルのディレクトリ名とは一致しないことが
// あり、例えば agent-toolkit はディレクトリ上 agenttoolkit になっている。
// 新しい AWS CLI に上げたときは同じ観点で見直す。
const DENY_EXACT = new Set([
  // Cognito Identity。ID プールのロールの一時認証情報が返る。呼び出しは
  // 利用者側のトークンで通るため、verify セッションの Deny も ReadOnlyAccess の
  // 枠も効かない。この関門が唯一の防ぎ手になる
  'cognito-identity get-credentials-for-identity',
  'cognito-identity get-id',
  'cognito-identity get-open-id-token',
  // Cognito User Pools の利用者向け操作。利用者の access token で本人のデータと
  // トークンが読める。deny ポリシーが止めているのは Admin* の側だけで、
  // IAM で認証されないこちらには届かない
  'cognito-idp get-user',
  'cognito-idp get-user-attribute-verification-code',
  'cognito-idp get-user-auth-factors',
  'cognito-idp get-tokens-from-refresh-token',
  'cognito-idp get-device',
  'cognito-idp list-devices',
  'cognito-idp list-web-authn-credentials',
  // ここから下は IAM で認証されるので Deny も枠も効くが、返るのが資格情報そのもの。
  // 手に入れば以降の操作は環境変数や SDK 経由になり、この関門からは見えなくなる。
  // 確認作業のどれにも要らないので落とす
  'sts get-session-token', 'sts get-federation-token',
  'sts get-delegated-access-token', 'sts get-web-identity-token',
  'ecr get-login-password', 'ecr get-authorization-token',
  'ecr-public get-login-password', 'ecr-public get-authorization-token',
  'eks get-token',
  'codeartifact get-authorization-token',
]);

// シェルの区切り文字。引用符の外にあるときだけ区切りとして扱う
const SEPARATORS = ['&&', '||', ';', '|', '&', '>', '<', '(', ')', '`'];
const SEPARATOR_CHARS = ';|&<>()`';

// 読み切れなかったコマンドを表す。判定できないものは通さず拒否側に倒す
class UnparsableCommand extends Error {}

// ANSI-C 引用（$'…'）の中の打ち消しを実際の文字に戻す。bash はここで \x61 の
// ような表記を解釈するため、字面のまま読むとコマンド名を見落とす
const ANSI_C_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n',
  r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// 数値指定の打ち消しを文字に直す。\U は 8 桁取れるので Unicode の範囲を
// 超え得るが、超える値を String.fromCodePoint に渡すと例外になる
const codeToChar = (code) => (code <= 0x10ffff ? String.fromCodePoint(code) : '');

// 語から取り除く不可視文字。混ぜるだけで名前の形が崩れ、「CLI 呼び出しでは
// ない」と判断されて素通りするため、照合の前に落とす（$'\x01logs' のような形）。
//
// 個別の符号位置ではなく Unicode の分類で指定している。範囲を継ぎ足していく形だと、
// 隣の範囲が残るたびに同じ穴が開き直すため。
//
//   Cc / Cf … 制御文字と書式用。C0・DEL・C1、ゼロ幅スペース、BOM、ソフトハイフン
//   M       … 結合文字。前の字を飾るだけで単独では字にならない
//   Co      … 私用領域。表示のされ方が決まっておらず、字として意味を持たない
//   Cs      … 孤立サロゲート。文字を成さない壊れた符号単位
//   Cn      … 非文字。字として割り当てられることのない符号位置
//
// 線引きは「それ単独で字にならないもの」。字として成立する文字（同形異字や修飾文字）は
// ここでは落とさず、名前を読むときに toCliName 側でまとめて扱う。
//
// bash が実際に落とすのは NUL だけで、他はそのまま子プロセスへ渡る。それでも
// 落とすのは、AWS CLI のサービス名・操作名にこれらが入り得ないため。混ざった名前は
// AWS CLI 自身が弾くので、落として照合しても新たに止まるのは元々実行できない
// コマンドだけで済む。
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{M}\p{Co}\p{Cs}\p{Cn}]/gu;

function decodeAnsiC(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\' || i + 1 >= body.length) { out += body[i]; continue; }
    i += 1;
    const c = body[i];
    if (c in ANSI_C_ESCAPES) { out += ANSI_C_ESCAPES[c]; continue; }
    // \xHH / \uHHHH / \UHHHHHHHH と、8 進の \nnn
    const digits = (pattern) => (body.slice(i + 1).match(pattern) ?? [''])[0];
    const radix16 = { x: 2, u: 4, U: 8 }[c];
    if (radix16) {
      const h = digits(new RegExp(`^[0-9a-fA-F]{1,${radix16}}`));
      if (h) {
        out += codeToChar(parseInt(h, 16));
        i += h.length;
        continue;
      }
    }
    if (c >= '0' && c <= '7') {
      const o = (body.slice(i).match(/^[0-7]{1,3}/) ?? [''])[0];
      out += codeToChar(parseInt(o, 8));
      i += o.length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

// コマンド文字列をシェルに近い形で語に分ける。字面をそのまま切っていたときに
// 見落としていた形が、レビューで順に挙がった。
//
//   1. 区切り文字が空白で挟まれていないと直前の引数と融合する（/my-group;aws …）
//   2. 語の途中の引用符を落とさないと、シェルが語結合で組み立てる名前を別物として
//      読む。bash は ""s3api も s""3api も s3api という 1 語にする
//   3. 引用や打ち消しでコマンド名そのものを隠せる。$'\x61\x77\x73' も $"aws" も
//      bash では aws になり、\ と改行は行継続として消える
//
// どれもシェルの語の作り方を写していないことが原因なので、引用と打ち消しを
// 解いてから語をつなぐ。区切りは引用の外でだけ切る
function tokenize(command, nesting = 0) {
  if (nesting > 32) throw new UnparsableCommand('コマンド置換の入れ子が深すぎる');

  const tokens = [];
  // 組み立て中の語。「まだ始まっていない」と「空の語」を区別するため null 始まり
  let word = null;
  // 二重引用符の内側か。$"…" もロケール変換が働かない限り同じ扱いになる
  let inDoubleQuote = false;
  const add = (s) => { word = (word ?? '') + s; };
  // 不可視文字は語を確定するときにまとめて落とす。打ち消しの表記（\x01）でも
  // 名前付きの打ち消し（\a や \n）でも、引用の中の生の文字でも同じ経路を通る
  const flush = () => {
    if (word !== null) tokens.push(word.replace(INVISIBLE_CHARS, ''));
    word = null;
  };
  const openDoubleQuote = () => { inDoubleQuote = true; word = word ?? ''; };

  const isSubstitution = (i) => command[i] === '`' || (command[i] === '$' && command[i + 1] === '(');

  // コマンド置換の中身を切り出し、同じ規則で読み直して区切りで挟んで足す。
  // 引用の状態には触らないので、置換のあとも元の引用が続いているものとして読める。
  // 以前は引用の外に出る形にしていたが、それだと元の引用を閉じる " が開き側と
  // 見なされ、後ろのコマンドをまるごと 1 語に飲み込んでいた
  const consumeSubstitution = (start) => {
    const isBacktick = command[start] === '`';
    let depth = 1;
    let body = '';
    let j = start + (isBacktick ? 1 : 2);
    for (; j < command.length; j += 1) {
      const ch = command[j];
      if (isBacktick) {
        // バッククォートの中では \` と \\ が打ち消し。閉じと取り違えないよう読み飛ばす。
        // bash は打ち消しを外してから中身を実行するので、外した形で本体に積む。
        // 外さずに積むと、入れ子のバッククォートが復元されず中の呼び出しを見落とす
        if (ch === '\\' && (command[j + 1] === '`' || command[j + 1] === '\\')) {
          body += command[j + 1];
          j += 1;
          continue;
        }
        if (ch === '`') break;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      body += ch;
    }
    if (j >= command.length) throw new UnparsableCommand('閉じていないコマンド置換');
    flush();
    tokens.push('(', ...tokenize(body, nesting + 1), ')');
    return j;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];

    if (inDoubleQuote) {
      if (c === '"') { inDoubleQuote = false; continue; }
      // 二重引用符の中では \ が打ち消しになるので、置換の判定より先に見る
      if (c === '\\' && i + 1 < command.length) { i += 1; add(command[i]); continue; }
      // 二重引用符の中でもコマンド置換は効く
      if (isSubstitution(i)) { i = consumeSubstitution(i); continue; }
      add(c);
      continue;
    }

    if (c === '\\' && command[i + 1] === '\n') { i += 1; continue; } // 行継続。両方消える
    if (c === '\\' && i + 1 < command.length) { add(command[i + 1]); i += 1; continue; }

    if (isSubstitution(i)) { i = consumeSubstitution(i); continue; }

    if (c === '$' && command[i + 1] === "'") {
      let body = '';
      let j = i + 2;
      for (; j < command.length && command[j] !== "'"; j += 1) {
        if (command[j] === '\\' && j + 1 < command.length) {
          body += command[j] + command[j + 1];
          j += 1;
          continue;
        }
        body += command[j];
      }
      if (j >= command.length) throw new UnparsableCommand('閉じていない $\'…\'');
      add(decodeAnsiC(body));
      i = j;
      continue;
    }
    if (c === '$' && command[i + 1] === '"') { openDoubleQuote(); i += 1; continue; }
    if (c === '"') { openDoubleQuote(); continue; }

    if (c === "'") {
      // シングルクォートの中に打ち消しは無い
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new UnparsableCommand('閉じていない引用符');
      add(command.slice(i + 1, end));
      i = end;
      continue;
    }

    if (/\s/.test(c)) { flush(); continue; }

    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { flush(); tokens.push(two); i += 1; continue; }
    if (SEPARATOR_CHARS.includes(c)) { flush(); tokens.push(c); continue; }

    add(c);
  }
  if (inDoubleQuote) throw new UnparsableCommand('閉じていない引用符');
  flush();
  return tokens;
}

// 実際の AWS CLI のサービス名・操作名は英小文字・数字・ハイフンでできている。
// この形から外れるものは CLI 呼び出しではないと見なす。日本語の散文に混じった
// aws（コミットメッセージなど）や、/usr/local/bin/aws を引数に取る rm を
// 呼び出しと誤認しないため。どちらも実際に誤検知した
const CLI_NAME = /^[a-z0-9][a-z0-9-]*$/;

// 語を CLI の名前として読む。そのままの形で読めなければ、非 ASCII の文字だけを
// 落としてもう一度見る。
//
// 名前に混ぜ物をして形を崩すと素通りする、という指摘が繰り返し挙がった。制御文字、
// 結合文字、私用領域、孤立サロゲート、非文字、置換文字、同形異字、修飾文字と、
// 使われる文字は毎回違う。Unicode の分類を継ぎ足す形だと隣が残るたびに同じ穴が
// 開き直すので、「落とすと名前になるなら、その名前として判定する」形でまとめて閉じる。
//
// 落とすのを非 ASCII に限っているのは、ASCII の記号は引数として正当に使われるため。
// すべて落とすと /usr/local/bin/aws_completer や scripts/ のような引数が名前に化け、
// 実際に誤検知した。AWS CLI の名前に非 ASCII は入り得ないので、そちらだけ落とす。
//
// 落として空になる語（日本語の散文など）は名前ではないので、呼び出しと見なさない。
// これで「aws が入っておらず…」のような文面を止めずに済む。
//
// 混ぜ物のある名前は AWS CLI 自身も ParamValidation で弾くので、この判定で新たに
// 止まるのは元々実行できないコマンドだけになる
function toCliName(word) {
  if (CLI_NAME.test(word)) return word;
  const ascii = word.replace(/[^\x00-\x7f]/g, '');
  return CLI_NAME.test(ascii) ? ascii : '';
}

// tokens[i] が 'aws' のとき、そこから service と operation を読み取る
function parseInvocation(tokens, i) {
  const words = [];
  let j = i + 1;
  while (j < tokens.length && words.length < 2) {
    const t = tokens[j];
    if (t === '--version' || t === 'help') return { service: t, operation: '', safe: true };
    if (t.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(t) && j + 1 < tokens.length) j += 1;
      j += 1;
      continue;
    }
    // シェルの区切りに当たったら、その aws 呼び出しはそこで終わり
    if (SEPARATORS.includes(t)) break;
    // 空の語は読み飛ばす。bash は空文字を引数として渡すが、サービス名の位置に
    // 空が来た時点でその呼び出しは成立しないので、後ろの語で判定する
    if (t === '') { j += 1; continue; }
    words.push(t);
    j += 1;
  }
  if (words.length === 0) return { service: '', operation: '', safe: true };
  // 変数展開が絡む語は何に化けるか読めないので、呼び出しとして拒否側に倒す
  if (words[0].includes('$')) return { service: words[0], operation: '', safe: false };
  // 落としても名前にならなければ、そもそも呼び出しではない
  const service = toCliName(words[0]);
  if (!service) return { service: '', operation: '', safe: true };
  // 操作名が読めない場合は空にする。空は isRead が false を返すので拒否側に倒れる
  return {
    service,
    operation: toCliName(words[1] ?? ''),
    safe: false,
  };
}

function isRead(service, operation) {
  if (!operation) return false;
  // 落とす側を先に見る。後から許可リストに同じものが足されても、こちらが勝つ
  if (DENY_EXACT.has(`${service} ${operation}`)) return false;
  if (READ_EXACT.has(`${service} ${operation}`)) return true;
  // s3 の高レベルコマンドは cp / mv / rm / sync / mb / rb が書き込みなので
  // 上の READ_EXACT に載せた ls だけを通す
  if (service === 's3') return false;
  // SSO Portal API（sso）と、そのトークンを作る側（sso-oidc）は、上で通した
  // sso login を除いて全部落とす。get-role-credentials に access token を渡すと
  // その利用者に割り当てられた任意のロール（AdministratorAccess を含む）の
  // 一時認証情報が返るうえ、この2サービスの呼び出しは SigV4 で署名されないため、
  // verify セッションに重ねた Deny も ReadOnlyAccess の枠も一切効かない。
  // サービス単位で落としておけば、将来 AWS が読み取りの名前で操作を足しても素通りしない。
  //
  // agent-toolkit も 6 操作すべてが署名されないので同じ扱いにする。返るのは AWS 側の
  // スキルカタログで、資格情報も利用者データも含まないが、IAM が一切届かないうえ
  // この確認作業では使わないため、通す理由がない。get-skill-file は外部の内容を
  // そのままセッションに引き込む口でもある
  if (service === 'sso' || service === 'sso-oidc' || service === 'agent-toolkit') return false;
  if (operation === 'wait' || operation === 'help') return true;
  return READ_PREFIXES.some((p) => operation.startsWith(p));
}

// その語が AWS CLI の呼び出しかどうか。'aws' 単体と、'aws' で終わるパス
// （/usr/local/bin/aws）の両方を見る。名前の位置と同じく混ぜ物を置けるので、
// 非 ASCII を落とした形でも同じ2つを見る。
//
// ただし、実体を別名で置いて呼ぶ形（cp や ln で /tmp/x にしてから /tmp/x s3 rm …）は
// ここでは拾えない。名前を手がかりにする方式では原理的に追えないので、先頭に書いた
// 「サンドボックスではない」の範囲に含まれる
function isAwsCommand(token) {
  if (token === 'aws' || token.endsWith('/aws')) return true;
  const ascii = token.replace(/[^\x00-\x7f]/g, '');
  return ascii === 'aws' || ascii.endsWith('/aws');
}

function findDenied(command) {
  const tokens = tokenize(command);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isAwsCommand(tokens[i])) continue;
    const { service, operation, safe } = parseInvocation(tokens, i);
    if (safe || !service) continue;
    if (!isRead(service, operation)) {
      return `aws ${service} ${operation}`.trim();
    }
  }
  return null;
}

// 判定は常に走らせる。「直接実行されたときだけ動かす」形にすると、実行パスに
// シンボリックリンクが挟まったときに判定ごと素通りする（argv[1] は解決されず、
// import.meta.url は解決済みなので一致しない）。テストは import ではなく
// このスクリプトを子プロセスとして起動する形にしてある
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch {
    // 入力を解釈できないときは判定しない（通常の権限フローに任せる）
    process.exit(0);
  }

  const deny = (reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  };

  // 判定そのものが失敗したら拒否側に倒す。例外のまま落ちると終了コードが 1 に
  // なり、フックの異常として素通りする（実際に \U の範囲外でそうなった）
  let denied;
  try {
    denied = findDenied(command);
  } catch (e) {
    const detail = e instanceof UnparsableCommand ? e.message : '判定に失敗';
    deny(
      `コマンドを解釈できなかったため許可できません（${detail}）。`
      + 'AWS 変更操作を見落とさないよう、読み切れないコマンドは通していません。',
    );
    return;
  }

  if (!denied) process.exit(0);

  deny(
    `クラウドセッションからの AWS 変更操作は禁止されています（検出: ${denied}）。`
    + 'verify プロファイルは読み取り専用です。変更が必要な場合は人間に依頼してください。',
  );
});
