import type { UiLang } from './i18n';

/** Kus textu příručky: odstavec, odrážky, nebo zvýrazněný tip. */
export type HelpBlock = { p: string } | { ul: string[] } | { tip: string };

export interface HelpSection {
  /** Kotva pro odkaz z ikonky „?“ u volby. */
  id: HelpTopic;
  title: string;
  blocks: HelpBlock[];
}

export type HelpTopic = 'start' | 'provider' | 'modes' | 'options' | 'results' | 'glossary' | 'problems' | 'about';

const cs: HelpSection[] = [
  {
    id: 'start',
    title: 'Rychlý start',
    blocks: [
      {
        ul: [
          '1. Přetáhni soubor do okna (PDF i sken, Word, TXT nebo Markdown), nebo klikni na plochu a vyber ho.',
          '2. Zvol, kde se má překládat (Lokálně, nebo Online) a v jakém režimu.',
          '3. Zkontroluj jazyk a případně rozsah stránek a klikni na Přeložit.',
        ],
      },
      { p: 'Překlad běží na pozadí, průběh vidíš na úvodní stránce. Hotové překlady najdeš v Historii, kde je otevřeš, porovnáš s originálem nebo uložíš.' },
      { tip: 'Do fronty můžeš přidat víc souborů najednou, přeloží se postupně.' },
    ],
  },
  {
    id: 'provider',
    title: 'Lokálně, nebo online?',
    blocks: [
      { p: 'Lokálně: překládají modely v aplikaci LM Studio přímo v tvém počítači. Je to zdarma a text nikam neodchází, takže se hodí i pro citlivé dokumenty. Potřebuje výkonnější počítač a je pomalejší.' },
      { p: 'Online (API): překládá model přes službu OpenRouter. Je výrazně rychlejší a stačí jakýkoli počítač, ale text se posílá přes internet a platí se z kreditu (typický článek stojí zlomky korun). Potřebuješ API klíč z openrouter.ai, který uložíš v Nastavení.' },
      { p: 'Vedle přepínače vidíš, jakým modelem se bude překládat a jestli je API klíč uložený. Modely vybíráš v Nastavení; doporučený online model je DeepSeek V4.1 Flash.' },
      { tip: 'Odhad ceny se ukáže pod volbami hned po přidání souboru, skutečná cena je po dokončení v detailu překladu.' },
    ],
  },
  {
    id: 'modes',
    title: 'Režimy překladu',
    blocks: [
      {
        ul: [
          'Rychlý: text se bere přímo z PDF, OCR jen u naskenovaných stránek. Chyby se v překladu jen označí. Na rychlé zorientování.',
          'Vyvážený: všechny stránky přečte OCR model (lépe pozná tabulky a pořadí textu), překlad se zkontroluje a nalezené chyby se opraví. Doporučená volba.',
          'Kvalitní: navíc si nejdřív přečte začátek dokumentu a zjistí téma, obor a autora (kvůli správnému rodu a terminologii). Nejpomalejší, nejpřesnější.',
        ],
      },
      { p: 'Odhad času na stránku se zpřesňuje podle toho, jak rychle ti překlady skutečně běží.' },
    ],
  },
  {
    id: 'options',
    title: 'Volby před překladem',
    blocks: [
      {
        ul: [
          'Z jazyka / Do jazyka: jazyk originálu se obvykle pozná sám. Když je dokument už v cílovém jazyce, aplikace na to upozorní.',
          'Stránky PDF: přelož jen část, např. 1-8 nebo 1-3, 5. Prázdné pole znamená celý dokument.',
          'Vybrat odstavce před překladem: aplikace dokument nejdřív přečte a ty zaškrtneš, které odstavce chceš přeložit. Ostatní zůstanou v originále; další odstavce můžeš přeložit později.',
          'Tabulky a grafy z originálu: tabulka nebo graf s popiskem (Table 1, Figure 2…) se nepřekládá a vloží se jako obrázek z originální stránky, přeloží se jen popisek. Doporučeno, tabulky tak zůstanou přesně jako v originále.',
        ],
      },
    ],
  },
  {
    id: 'results',
    title: 'Výsledek překladu',
    blocks: [
      { p: 'Po kliknutí na překlad v Historii se otevře detail se záložkami:' },
      {
        ul: [
          'Srovnání: originál a překlad odstavec po odstavci vedle sebe. Žlutě jsou označená místa, která stojí za kontrolu (možný překlep, nepřeložené slovo, chybějící termín z glosáře).',
          'Překlad PDF: přeložené PDF, které vypadá jako originál (stejné rozložení, obrázky i tabulky).',
          'PDF vedle sebe: originál a přeložené PDF vedle sebe, stránky se posouvají spolu.',
          'Překlad: celý přeložený text jako souvislý dokument.',
          'Originál: původní soubor.',
          'Informace: použitý model, čas, cena a poznámky ke zpracování.',
        ],
      },
      { p: 'Tlačítky nahoře otevřeš PDF nebo Word, uložíš výsledek jinam, nebo dokument přeložíš znovu v jiném režimu. „Znovu vysázet PDF“ vytvoří přeložené PDF znovu bez nového překladu.' },
      { tip: 'V záložkách s PDF můžeš myší označit oblast stránky (třeba graf nebo obrázek s textem) a nechat si ji přeložit zvlášť.' },
    ],
  },
  {
    id: 'glossary',
    title: 'Glosář',
    blocks: [
      { p: 'Glosář je seznam odborných termínů a jejich závazných překladů, např. „large language model = velký jazykový model“. Aplikace ho použije u všech překladů a odstavec, kde termín chybí, opraví nebo označí.' },
      { tip: 'Zadávej termín tak, jak se píše v originále; v překladu se použije ve správném pádě.' },
    ],
  },
  {
    id: 'problems',
    title: 'Když něco nejde',
    blocks: [
      {
        ul: [
          'LM Studio nenalezeno nebo neběží: nainstaluj LM Studio z lmstudio.ai; server se při překladu spustí sám. Chybějící model si stáhni v LM Studiu (jména najdeš v Nastavení).',
          'Chybí API klíč: v Nastavení vlož klíč z openrouter.ai a ulož ho. Klíč se ukládá šifrovaně v systému.',
          'Došel kredit nebo neplatný klíč: aplikace to ohlásí chybou u překladu; dobij kredit na openrouter.ai nebo ulož nový klíč a dej „Přeložit znovu“.',
          'Naskenovaný dokument: přelož ho v režimu Vyvážený nebo Kvalitní, text pak přečte OCR model z obrázku stránky.',
          'Rozházené pořadí textu nebo rozbitá tabulka: zkus režim Vyvážený, zapni „Tabulky a grafy z originálu“ a zkontroluj místa označená ve Srovnání.',
          'Přeložené PDF chybí: důvod najdeš v záložce Informace. Word a Srovnání jsou k dispozici vždy.',
        ],
      },
    ],
  },
  {
    id: 'about',
    title: 'O aplikaci',
    blocks: [{ p: 'TransLatte překládá odborné dokumenty se zachováním vzhledu. Lokální modely běží v LM Studiu, online modely přes OpenRouter.' }],
  },
];

const en: HelpSection[] = [
  {
    id: 'start',
    title: 'Quick start',
    blocks: [
      {
        ul: [
          '1. Drop a file into the window (PDF including scans, Word, TXT or Markdown), or click the area and pick it.',
          '2. Choose where to translate (Locally or Online) and the mode.',
          '3. Check the language and page range if needed, then click Translate.',
        ],
      },
      { p: 'Translation runs in the background; progress is shown on the home screen. Finished translations are in History, where you can open them, compare them with the original or save them.' },
      { tip: 'You can queue several files at once; they are translated one after another.' },
    ],
  },
  {
    id: 'provider',
    title: 'Locally or online?',
    blocks: [
      { p: 'Locally: models in the LM Studio app translate right on your computer. It is free and the text never leaves your machine, so it suits confidential documents. It needs a more powerful computer and is slower.' },
      { p: 'Online (API): a model translates via the OpenRouter service. It is much faster and works on any computer, but the text is sent over the internet and paid from your credit (a typical article costs a fraction of a cent to a few cents). You need an API key from openrouter.ai, saved in Settings.' },
      { p: 'Next to the switch you can see which model will translate and whether the API key is saved. Models are chosen in Settings; the recommended online model is DeepSeek V4.1 Flash.' },
      { tip: 'A cost estimate appears below the options as soon as you add a file; the actual cost is shown in the translation details when it finishes.' },
    ],
  },
  {
    id: 'modes',
    title: 'Translation modes',
    blocks: [
      {
        ul: [
          'Fast: text is taken straight from the PDF, OCR only for scanned pages. Errors are only flagged. Good for a quick overview.',
          'Balanced: an OCR model reads every page (better tables and reading order), the translation is checked and the issues found are fixed. Recommended.',
          'Quality: first reads the beginning of the document to learn its topic, field and author (for correct grammatical gender and terminology). Slowest, most accurate.',
        ],
      },
      { p: 'The time-per-page estimate improves based on how fast your translations actually run.' },
    ],
  },
  {
    id: 'options',
    title: 'Options before translating',
    blocks: [
      {
        ul: [
          'From / To: the source language is usually detected automatically. If the document is already in the target language, the app warns you.',
          'PDF pages: translate only part of it, e.g. 1-8 or 1-3, 5. Empty means the whole document.',
          'Choose paragraphs before translating: the app reads the document first and you tick the paragraphs to translate. The rest stays in the original; you can translate more later.',
          'Tables and figures from the original: a table or figure with a caption (Table 1, Figure 2…) is not translated but inserted as an image of the original page; only the caption is translated. Recommended, so tables stay exactly as in the original.',
        ],
      },
    ],
  },
  {
    id: 'results',
    title: 'The translation result',
    blocks: [
      { p: 'Clicking a translation in History opens its details with these tabs:' },
      {
        ul: [
          'Comparison: original and translation side by side, paragraph by paragraph. Spots worth checking are highlighted (possible typo, untranslated word, missing glossary term).',
          'Translated PDF: a translated PDF that looks like the original (same layout, images and tables).',
          'PDFs side by side: the original and the translated PDF next to each other, scrolling together.',
          'Translation: the whole translated text as one document.',
          'Original: the source file.',
          'Information: the model used, time, cost and processing notes.',
        ],
      },
      { p: 'The buttons at the top open the PDF or Word file, save the result elsewhere, or translate the document again in another mode. “Rebuild PDF” builds the translated PDF again without a new translation.' },
      { tip: 'In the PDF tabs you can drag over an area of a page (such as a chart or an image with text) and have it translated separately.' },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    blocks: [
      { p: 'The glossary is a list of technical terms with their mandatory translations, e.g. “large language model = velký jazykový model”. The app uses it for every translation and fixes or flags paragraphs where a term is missing.' },
      { tip: 'Enter the term as written in the original; the translation uses it in the grammatically correct form.' },
    ],
  },
  {
    id: 'problems',
    title: 'Troubleshooting',
    blocks: [
      {
        ul: [
          'LM Studio not found or not running: install LM Studio from lmstudio.ai; its server starts automatically when translating. Download any missing model in LM Studio (names are listed in Settings).',
          'API key missing: paste a key from openrouter.ai in Settings and save it. The key is stored encrypted by the system.',
          'Out of credit or invalid key: the translation fails with an error; top up at openrouter.ai or save a new key and click “Translate again”.',
          'Scanned document: translate it in Balanced or Quality mode so the OCR model reads the page image.',
          'Jumbled text order or broken table: try Balanced mode, turn on “Tables and figures from the original” and check the spots highlighted in Comparison.',
          'Translated PDF missing: the reason is in the Info tab. Word and Comparison are always available.',
        ],
      },
    ],
  },
  {
    id: 'about',
    title: 'About',
    blocks: [{ p: 'TransLatte translates academic documents while keeping their layout. Local models run in LM Studio, online models via OpenRouter.' }],
  },
];

export const helpSections = (lang: UiLang): HelpSection[] => (lang === 'cs' ? cs : en);
