import { describe, expect, it } from 'vitest';
import { trapStep } from './useDialogFocus';

describe('dialog focus trap', () => {
  it('should wrap Tab and Shift+Tab at the edges and leave the middle to the browser', () => {
    expect(trapStep(3, 2, false)).toBe(0);
    expect(trapStep(3, 0, true)).toBe(2);
    expect(trapStep(3, 1, false)).toBeUndefined();
    expect(trapStep(3, 1, true)).toBeUndefined();
    expect(trapStep(3, 0, false)).toBeUndefined();
  });

  it('should pull focus back in from outside the dialog (or the dialog itself)', () => {
    expect(trapStep(3, -1, false)).toBe(0);
    expect(trapStep(3, -1, true)).toBe(2);
    expect(trapStep(1, 0, false)).toBe(0);
    expect(trapStep(1, 0, true)).toBe(0);
  });

  it('should keep focus on the dialog when nothing in it is focusable', () => {
    expect(trapStep(0, -1, false)).toBe(-1);
    expect(trapStep(0, -1, true)).toBe(-1);
  });
});
