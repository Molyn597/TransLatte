import { describe, expect, it } from 'vitest';
import { unshiftText } from '../src/shared/pdf';

describe('unshiftText', () => {
  it('vrátí posunuté znaky japonského MS Office na čitelný text', () => {
    expect(unshiftText('㻝㻢㻜㻜')).toBe('1600');
    expect(unshiftText('㻿㼑㼙㼕㼏㼛㼚')).toBe('Semicon');
    expect(unshiftText('㻹㼑㼐㼕㼏㼍㼘㻌㼠㼑㼏㼔')).toBe('Medical tech');
  });

  it('běžný text nechá beze změny', () => {
    expect(unshiftText('Optics 1600')).toBe('Optics 1600');
  });

  it('čínský a japonský text mimo posunutý rozsah nechá beze změny', () => {
    expect(unshiftText('日本語')).toBe('日本語');
  });

  it('směs, kde posunuté znaky nejsou aspoň 80 %, nechá beze změny', () => {
    expect(unshiftText('abc㻝')).toBe('abc㻝');
  });
});
