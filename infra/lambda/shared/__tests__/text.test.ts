import { describe, expect, it } from 'vitest';
import { clipText, dropBrokenCharacters } from '../text';

describe('壊れた文字を落とす', () => {
  it('対になっていないサロゲートだけを落とす', () => {
    expect(dropBrokenCharacters('a\ud83db🚨c\udea8')).toBe('ab🚨c');
  });
});

describe('文字列を切り詰める', () => {
  it('上限以内ならそのまま返す', () => {
    expect(clipText('あいう', 3)).toBe('あいう');
  });

  it('省略記号を含めて上限に収める', () => {
    expect(clipText('あいうえお', 4)).toBe('あいう…');
    expect(clipText('あいうえお', 4, '（略）')).toBe('あ（略）');
  });

  it('絵文字の途中では切らない', () => {
    // 🚨 は UTF-16 で 2 単位。4 単位に収めるなら 1 つと省略記号まで
    const clipped = clipText('🚨🚨🚨', 4);
    expect(clipped).toBe('🚨…');
    expect(() => encodeURIComponent(clipped)).not.toThrow();
  });
});
