declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }
  function nspell(aff: Buffer | string, dic?: Buffer | string): NSpell;
  export = nspell;
}
