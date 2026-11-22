# コントラストの測り方

文字が読めない不具合は、目視では「なんとなく薄い」としか見えない。原因の多くは、文字色と地の色が別々の規則で決まり、置き場所によって片方だけ上書きされること。場所ごとに直しても、別の場所で同じことが起きる。画面全体を一度に測る。

## 明度比の計算

```python
def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def luminance(hex_color):
    h = hex_color.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

def ratio(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)
```

| 用途 | 明度比の下限 |
|---|---|
| 本文の文字 | 4.5 |
| 大きい太字（見出し、24px 前後の太字） | 3.0 |
| 罫線、入力欄の枠 | 1.5〜3（区切りが見えれば足りる） |

面を明るくするほど、上に乗せる白文字は読みにくくなる。面の色だけを見て決めず、上に乗る文字との比で上限を決める。

## 画面全体を一度に測る

ブラウザで画面を開き、開発者ツールのコンソールで流す。直接テキストを持つ要素ごとに、文字色と実際の地の色の明度差を出し、低いものを並べる。グラデーションの上の文字は対象から外す（白文字が正しい前提）。

```javascript
(() => {
  const lum = c => { const m = (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]; };
  const alpha = c => { const m = c.match(/[\d.]+/g) || []; return m.length > 3 ? Number(m[3]) : 1; };
  const effectiveBg = el => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) return { gradient: true };
      if (alpha(cs.backgroundColor) > 0.05) return { lum: lum(cs.backgroundColor), raw: cs.backgroundColor };
    }
    return { lum: 255, raw: 'rgb(255, 255, 255)' };
  };
  const low = [];
  document.querySelectorAll('body *').forEach(el => {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
    const bg = effectiveBg(el);
    if (bg.gradient) return;
    const color = getComputedStyle(el).color;
    if (Math.abs(lum(color) - bg.lum) < 60) {
      low.push({ tag: el.tagName.toLowerCase(), color, bg: bg.raw, text: el.textContent.trim().slice(0, 40) });
    }
  });
  return { 件数: low.length, 一覧: low };
})()
```

`件数` が 0 になるまで直す。明度差 60 は簡易の目安で、迷う箇所は上の Python で比を出して確かめる。

## よくある原因

- **`code` の地と文字色が別の規則にある。** 共通の `code { background: 淡い色 }` と、暗い枠の中の `pre code { color: 白 }` が別々に当たり、詳細度の高いほうの地だけが残って白地に白文字になる。暗い枠の中の `code` には、地と文字色を同じ規則で書く
- **ヒーローなど濃い帯の中だけ白文字にしている。** 帯の中の要素を1つずつ列挙して白を当てると、新しい要素を足したときに漏れる。`.hero, .hero * { color: #fff }` のように子孫すべてへ当てる
- **後から足した広いセレクタが、既存の部品の文字色を上書きする。** 足す規則は、部品のクラスや節の ID で範囲を絞る
