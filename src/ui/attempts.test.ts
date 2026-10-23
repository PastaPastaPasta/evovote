import { describe, expect, it } from 'vitest';
import { attempts } from './attempts';

describe('attempts', () => {
  it('keeps an attempt current until another starts', () => {
    const a = attempts();
    const first = a.start();
    expect(first()).toBe(true);
    const second = a.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('drops a late result once the user cleared or switched input', () => {
    const a = attempts();
    const scan = a.start();
    a.cancel();
    expect(scan()).toBe(false);
    // A new attempt after the cancel counts again.
    expect(a.start()()).toBe(true);
  });
});
