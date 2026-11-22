# ストリーミング表示の実装（React）

## 届いた文字は、配列を作り直して足す

```typescript
// NG: 既存のオブジェクトを書き換える。StrictMode で更新関数が2回呼ばれ、文字が二重になる
setMessages(prev => {
  const next = [...prev];
  next[next.length - 1].content += chunk;
  return next;
});

// OK: map とスプレッドで新しいオブジェクトを返す
setMessages(prev =>
  prev.map((msg, i) =>
    i === prev.length - 1 && msg.role === 'assistant'
      ? { ...msg, content: msg.content + chunk }
      : msg
  )
);
```

## 状態の行を重ねない・まとめて閉じる

```typescript
// ツールの開始。同じ状態が進行中なら足さない
onToolStart: (label) => {
  setMessages(prev =>
    prev.some(m => m.isStatus && m.statusText === label && !m.done)
      ? prev
      : [...prev, { role: 'assistant', content: '', isStatus: true, statusText: label, done: false }]
  );
},

// 本文の文字が届いたら、進行中の状態を全部完了にしてから本文を足す
onText: (text) => {
  setMessages(prev => {
    const closed = prev.map(m => (m.isStatus && !m.done ? { ...m, done: true } : m));
    const last = closed[closed.length - 1];
    return last?.role === 'assistant' && !last.isStatus
      ? closed.map((m, i) => (i === closed.length - 1 ? { ...m, content: m.content + text } : m))
      : [...closed, { role: 'assistant', content: text }];
  });
},
```

`prev.map` の結果は新しい配列なので、その後の処理では `closed` を使う。`prev` を使い直すと、閉じた状態が戻る。

## タブを切り替えても会話を消さない

```tsx
// NG: 条件で描き分けると、切り替えのたびにアンマウントされて状態が消える
{tab === 'chat' ? <Chat /> : <Preview />}

// OK: 両方を描いたまま、片方を隠す
<div hidden={tab !== 'chat'}><Chat /></div>
<div hidden={tab !== 'preview'}><Preview /></div>
```

## 状態の行をフェードインさせる

アニメーションのクラスは、要素が作り直されないと再生されない。状態の文言が変わったら `key` を変える。

```tsx
<div key={`status-${statusText}`} className="fade-in">{statusText}</div>
```

## 1文字ずつ見せる（最初のひと言など）

```typescript
const typeOut = async (message: string) => {
  setMessages(prev => [...prev, { role: 'assistant', content: '', isStreaming: true }]);
  for (const ch of message) {
    await new Promise(r => setTimeout(r, 30));
    setMessages(prev =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant'
          ? { ...m, content: m.content + ch, isStreaming: true }
          : m
      )
    );
  }
  setMessages(prev => prev.map((m, i) => (i === prev.length - 1 ? { ...m, isStreaming: false } : m)));
};
```

ループの中でも毎回 `isStreaming: true` を付け直す。別の処理の `finally` が途中で `false` にすると、カーソルが消えたまま文字だけが増える。
