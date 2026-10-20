import { describe, expect, it } from 'vitest';
import { fixPrepositions, untranslatedWords } from '../src/main/czech';

describe('fixPrepositions', () => {
  it.each([
    ['s zaměstnanci', 'se zaměstnanci'],
    ['v Vídni', 've Vídni'],
    ['k kolegům', 'ke kolegům'],
    ['z Žďáru', 'ze Žďáru'],
    ['s mnou', 'se mnou'],
    ['k mně', 'ke mně'],
    ['S Sabinou', 'Se Sabinou'],
    ['v fakultě', 've fakultě'],
    ['k gymnáziu', 'ke gymnáziu'],
    ['z sebe', 'ze sebe'],
    ['V VÍDNI', 'VE VÍDNI'],
  ])('„%s“ → „%s“', (input, expected) => {
    expect(fixPrepositions(input)).toBe(expected);
  });

  it('opraví předložku uvnitř věty, po závorce i po uvozovkách', () => {
    expect(fixPrepositions('Mluvili jsme s zaměstnanci (v Vídni) a „k kolegům“.')).toBe(
      'Mluvili jsme se zaměstnanci (ve Vídni) a „ke kolegům“.',
    );
  });

  it.each([
    'v mnoha případech',
    's mnoha lidmi',
    's. 12',
    'v. r.',
    'v 5 hodin',
    'verze v2',
    'v1.2',
    'v v2',
    'se zaměstnanci',
    've Vídni',
    'ke kolegům',
    'ze Žďáru',
    's kolegy',
    'v Praze',
    'k nám',
    'z Brna',
    'vs zaměstnanci',
    's  zaměstnanci',
  ])('nemění „%s“', (input) => {
    expect(fixPrepositions(input)).toBe(input);
  });
});

describe('untranslatedWords', () => {
  it('nenahlásí „statistically“ ze skutečného překladu modelem (není v seznamu)', () => {
    expect(untranslatedWords('Statistically významná úroveň')).toEqual([]);
  });

  it('najde ponechaná funkční slova, unikátně a malými písmeny', () => {
    expect(untranslatedWords('The výsledky and data with the kontrolou. With ním.')).toEqual(['the', 'and', 'with']);
  });

  it('ignoruje text v uvozovkách a závorkách', () => {
    expect(untranslatedWords('Kniha „The Art of War“ a film "Gone with the Wind" (and more) i \'Of Mice and Men\'.')).toEqual(
      [],
    );
  });

  it('česká věta bez anglických slov a dvojznačná slova nic nenahlásí', () => {
    expect(untranslatedWords('To je on a ten most na listu, no a pan top film i do toho by my.')).toEqual([]);
  });
});
