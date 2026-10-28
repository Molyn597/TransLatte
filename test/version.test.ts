import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/shared/version';

describe('porovnání verzí', () => {
  it('pozná novější verzi', () => {
    expect(isNewer('0.1.6', '0.1.5')).toBe(true);
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
  });
  it('stejná nebo starší není novější', () => {
    expect(isNewer('0.1.5', '0.1.5')).toBe(false);
    expect(isNewer('0.1.4', '0.1.5')).toBe(false);
    expect(isNewer('v0.1.5', '0.1.5')).toBe(false);
    expect(isNewer('0.1', '0.1.0')).toBe(false);
  });
});
