import { describe, expect, it } from 'vitest';
import { documentOrder, rewriteDates } from '../src/main/dates';

describe('rewriteDates', () => {
  it('nejednoznačné datum v angličtině čte americky (měsíc/den) a upozorní na to', () => {
    // Skutečný případ z článku Adobe: 03-10-2014 je 10. března, ne 3. října.
    const { text, notes } = rewriteDates('Donna Morris 03-10-2014', 'en', 'cs');
    expect(text).toBe('Donna Morris March 10, 2014');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('10. března 2014');
  });

  it('jednoznačné datum přepíše bez upozornění', () => {
    expect(rewriteDates('Signed on 25/12/2014.', 'en', 'cs')).toEqual({ text: 'Signed on December 25, 2014.', notes: [] });
    expect(rewriteDates('Deadline 12/25/2014', 'en', 'cs')).toEqual({ text: 'Deadline December 25, 2014', notes: [] });
  });

  it('v němčině čte den/měsíc', () => {
    expect(rewriteDates('Am 03.10.2014 begann', 'de', 'cs').text).toBe('Am 3. Oktober 2014 begann');
  });

  it('pořadí z dokumentu má přednost před zvyklostí jazyka a nic nehlásí', () => {
    const { text, notes } = rewriteDates('Meeting 03/10/2014', 'en', 'cs', 'DMY');
    expect(text).toBe('Meeting October 3, 2014');
    expect(notes).toEqual([]);
  });

  it('ISO datum převede, stejný den a měsíc nehlásí', () => {
    expect(rewriteDates('Released 2014-10-03, updated 05/05/2015', 'en', 'cs')).toEqual({
      text: 'Released October 3, 2014, updated May 5, 2015',
      notes: [],
    });
  });

  it('neplatná data, verze a desetinná čísla nechá být', () => {
    const input = 'Version 1.2.2014.5, value 3.5, code 13/13/2014, phone 555-12-2014-11';
    expect(rewriteDates(input, 'en', 'cs').text).toBe(input);
  });
});

describe('documentOrder', () => {
  it('rozhodne podle data, kde je den větší než 12', () => {
    expect(documentOrder(['Start 03/10/2014', 'End 25/12/2014'])).toBe('DMY');
    expect(documentOrder(['Start 03/10/2014', 'End 12/25/2014'])).toBe('MDY');
  });

  it('bez jednoznačného data nerozhodne', () => {
    expect(documentOrder(['Start 03/10/2014'])).toBeUndefined();
  });
});
