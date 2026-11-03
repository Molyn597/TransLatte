import type { UiLang } from './i18n';

/** Kus textu příručky: odstavec, odrážky, nebo zvýrazněný tip. */
export type HelpBlock = { p: string } | { ul: string[] } | { tip: string };

export interface HelpSection {
  /** Kotva pro odkaz z ikonky „?“ u volby. */
  id: HelpTopic;
  title: string;
  blocks: HelpBlock[];
}

export type HelpTopic = 'start' | 'provider' | 'modes' | 'options' | 'results' | 'chat' | 'interface' | 'glossary' | 'updates' | 'problems' | 'about';

const cs: HelpSection[] = [
  {
    id: 'start',
    title: 'Rychlý start',
    blocks: [
      {
        ul: [
          '1. Přetáhni soubor do okna (PDF i sken, Word, TXT nebo Markdown), nebo klikni na Vybrat soubory.',
          '2. Na kartě pod tím zvol, kde se má překládat (V počítači, nebo Online), jazyk a případně kvalitu.',
          '3. Zkontroluj odhad dole a klikni na Přeložit.',
        ],
      },
      { p: 'Překlad běží na pozadí, průběh vidíš na úvodní stránce v části Probíhá. Hotové dokumenty najdeš v Nedávných dokumentech pod ním i v Historii; kliknutím je otevřeš, porovnáš s originálem, uložíš nebo se na ně zeptáš v chatu.' },
      { tip: 'Do fronty můžeš přidat víc souborů najednou, přeloží se postupně.' },
    ],
  },
  {
    id: 'provider',
    title: 'V počítači, nebo online?',
    blocks: [
      { p: 'V počítači: překládají modely v aplikaci LM Studio přímo u tebe. Je to zdarma a text nikam neodchází, takže se hodí i pro citlivé dokumenty. Potřebuje výkonnější počítač a je pomalejší.' },
      { p: 'Online: překládá model přes službu OpenRouter. Je výrazně rychlejší a stačí jakýkoli počítač, ale text se posílá přes internet a platí se z kreditu (typický článek stojí zlomky korun). Potřebuješ API klíč z openrouter.ai, který uložíš v Nastavení.' },
      { p: 'Řádek Model pod přepínačem ukazuje, který model se použije; kliknutím ho změníš. Chybí-li API klíč, upozorní tě na to. Doporučený online model je DeepSeek V4.1 Flash.' },
      { tip: 'Odhad času a ceny se ukáže dole na kartě hned po přidání souboru, skutečná cena je po dokončení v záložce Informace.' },
    ],
  },
  {
    id: 'modes',
    title: 'Kvalita překladu',
    blocks: [
      { p: 'Volba Kvalita je jen u překladu V počítači. Online se vždy použije nejlepší režim, takže se tam řádek nezobrazuje.' },
      {
        ul: [
          'Rychlá: text se bere přímo z PDF, OCR jen u naskenovaných stránek. Chyby se v překladu jen označí. Na rychlé zorientování.',
          'Vyvážená: všechny stránky přečte OCR model (lépe pozná tabulky a pořadí textu), překlad se zkontroluje a nalezené chyby se opraví. Doporučená volba.',
          'Nejlepší: navíc si nejdřív přečte začátek dokumentu a zjistí téma, obor a autora (kvůli správnému rodu a terminologii). Nejpomalejší, nejpřesnější.',
        ],
      },
      { p: 'Odhad času na stránku se zpřesňuje podle toho, jak rychle ti překlady skutečně běží.' },
    ],
  },
  {
    id: 'options',
    title: 'Další volby před překladem',
    blocks: [
      {
        ul: [
          'Jazyk: jazyk originálu se obvykle pozná sám. Když je dokument už v cílovém jazyce, aplikace na to upozorní.',
          'Navíc, Tabulky a grafy z originálu: tabulka nebo graf s popiskem (Table 1, Figure 2…) se nepřekládá a vloží se jako obrázek z originální stránky, přeloží se jen popisek. Doporučeno, tabulky tak zůstanou přesně jako v originále.',
          'Navíc, Vybrat odstavce před překladem: aplikace dokument nejdřív přečte a ty zaškrtneš, které odstavce chceš přeložit. Ostatní zůstanou v originále; další odstavce můžeš přeložit později.',
          'Jen některé stránky: otevře pole pro rozsah stránek PDF, např. 1-8 nebo 1-3, 5. Prázdné pole znamená celý dokument.',
        ],
      },
    ],
  },
  {
    id: 'results',
    title: 'Detail dokumentu',
    blocks: [
      { p: 'Po kliknutí na dokument se otevře jeho detail. Nahoře je pevná lišta: šipka zpět, název, stav a tlačítka Word a Otevřít PDF. V nabídce ⋯ je Uložit jako, Ve složce, Znovu vysázet PDF (vytvoří přeložené PDF znovu bez nového překladu), Přeložit znovu (v jiném režimu), Přeložit další odstavce (když něco zůstalo nepřeloženo) a Smazat z historie.' },
      { p: 'Pod lištou jsou záložky:' },
      {
        ul: [
          'Překlad: celý přeložený text jako souvislý dokument.',
          'Srovnání: originál a překlad odstavec po odstavci vedle sebe. Místa, která stojí za kontrolu (možný překlep, nepřeložené slovo, chybějící termín z glosáře), jsou označená; odkaz „N ke kontrole“ vpravo nahoře tě k prvnímu z nich přenese.',
          'Překlad PDF: přeložené PDF, které vypadá jako originál (stejné rozložení, obrázky i tabulky).',
          'PDF vedle sebe: originál a přeložené PDF vedle sebe, stránky se posouvají spolu.',
          'Originál: původní soubor.',
          'Informace: použitý model, čas, cena a poznámky ke zpracování.',
        ],
      },
      { p: 'V záložkách s PDF jde přiblížit: pinchem na trackpadu, Ctrl/Cmd a kolečkem myši, klávesami Cmd/Ctrl a +, − nebo 0 (původní velikost), případně plovoucím ovladačem na stránce.' },
      { tip: 'V PDF záložkách můžeš tažením myši označit oblast stránky (třeba graf nebo obrázek s textem) a nechat si ji přeložit zvlášť.' },
    ],
  },
  {
    id: 'chat',
    title: 'Chat s dokumentem',
    blocks: [
      { p: 'V detailu dokumentu se můžeš ptát na jeho obsah. Chat otevřeš tlačítkem vpravo nahoře nebo lištou u pravého okraje. Šířku panelu změníš tažením za jeho levý okraj a stejným tlačítkem ho zasuneš.' },
      { p: 'Odpovídá se jen z textu dokumentu. U odpovědi jsou čísla zdrojů [1], [2]…; kliknutím na číslo se místo zvýrazní v originálu i v překladu. Tlačítka Shrň dokument a Klíčové pojmy zeptají se na to nejčastější za tebe.' },
      { p: 'Dole vybíráš model. V počítači: dokument ani dotazy neopustí tvůj počítač. Online: dotaz a potřebné části textu se posílají přes OpenRouter, proto je potřeba API klíč z Nastavení.' },
      { p: 'Při odpovídání vidíš kroky: načítání modelu, hledání klíčových slov, nalezené úseky a psaní odpovědi.' },
      { p: 'Jak to funguje: krátký dokument model přečte celý. U dlouhého nejdřív vybere klíčová slova z otázky, vyhledá nejrelevantnější úseky a odpoví z nich. Citace se po odpovědi kontrolují, aby odkazovaly na skutečná místa v dokumentu.' },
      {
        ul: [
          'Studium: „Jaké jsou hlavní argumenty autora?“, „Vysvětli pojem X jednoduše.“, „Jakou metodu studie použila?“',
          'Smlouvy: „Jaká je výpovědní lhůta?“, „Jaké sankce hrozí při prodlení?“, „Jaké povinnosti má nájemce?“',
        ],
      },
      { tip: 'Chat není právní ani odborná rada a model se může mýlit. Důležité odpovědi si vždy ověř podle citací přímo v dokumentu.' },
      { p: 'Konverzace se ukládá k dokumentu a po znovuotevření tam zůstane. Tlačítkem Smazat konverzaci ji odstraníš.' },
    ],
  },
  {
    id: 'interface',
    title: 'Rozhraní a Nastavení',
    blocks: [
      {
        ul: [
          'Levý panel jde sbalit na samé ikony tlačítkem vlevo nahoře; stejným tlačítkem ho znovu rozbalíš.',
          'Stav připojení je dole v levém panelu (V počítači: LM Studio, Online: OpenRouter). Kliknutím zobrazíš podrobnosti a můžeš stav zkontrolovat znovu.',
          'Nastavení má sekce Vzhled (jazyk aplikace a barevný motiv Světlý, Tmavý nebo Podle systému), Překlad v počítači (modely LM Studia), Online (OpenRouter: API klíč, výběr modelu, měna cen) a Pokročilé (oznámení, PDF se zachovaným vzhledem, uvolnění modelů).',
        ],
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glosář',
    blocks: [
      { p: 'Glosář je seznam odborných termínů a jejich závazných překladů, např. „large language model = velký jazykový model“. Najdeš ho v levém panelu. Aplikace ho použije u všech překladů a odstavec, kde termín chybí, opraví nebo označí.' },
      { tip: 'Zadávej termín tak, jak se píše v originále; v překladu se použije ve správném pádě.' },
    ],
  },
  {
    id: 'updates',
    title: 'Aktualizace',
    blocks: [
      { p: 'Aplikace jednou denně sama zkontroluje, jestli je venku novější verze. Pokud ano, nahoře se objeví oznámení s tlačítky Co je nového, Stáhnout a nainstalovat a Později (skryje oznámení do příštího spuštění). Ruční kontrola je dole na této stránce.' },
      { p: 'Windows: instalátor se stáhne do složky Stažené, spustí se a TransLatte se ukončí; instalátor novou verzi nainstaluje a aplikaci znovu spustí.' },
      { p: 'macOS: stáhne se disk s instalací a otevře se. Přetáhni TransLatte do Aplikací a nahraď starou verzi, pak aplikaci spusť znovu. Tlačítko Ukončit TransLatte ti v tom pomůže.' },
      { tip: 'Když stažení selže, zobrazí se chyba a odkaz na stránku vydání, odkud soubor stáhneš ručně.' },
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
          'Došel kredit nebo neplatný klíč: aplikace to ohlásí chybou u překladu; dobij kredit na openrouter.ai nebo ulož nový klíč a dej Přeložit znovu.',
          'Naskenovaný dokument: přelož ho v kvalitě Vyvážená nebo Nejlepší (nebo Online), text pak přečte OCR model z obrázku stránky.',
          'Rozházené pořadí textu nebo rozbitá tabulka: zkus kvalitu Vyvážená, zapni Tabulky a grafy z originálu a zkontroluj místa označená ve Srovnání.',
          'Přeložené PDF chybí: důvod najdeš v záložce Informace. Word a Srovnání jsou k dispozici vždy.',
          'Chat neodpovídá: když zrovna běží překlad, model může čekat na jeho dokončení. Zkontroluj model vybraný dole v chatu a u Online také API klíč.',
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
          '1. Drop a file into the window (PDF including scans, Word, TXT or Markdown), or click Choose files.',
          '2. On the card below, choose where to translate (On this computer or Online), the language and, if needed, the quality.',
          '3. Check the estimate at the bottom and click Translate.',
        ],
      },
      { p: 'Translation runs in the background; progress is shown on the home screen under In progress. Finished documents are in Recent documents below it and in History; click one to open it, compare it with the original, save it or ask about it in the chat.' },
      { tip: 'You can queue several files at once; they are translated one after another.' },
    ],
  },
  {
    id: 'provider',
    title: 'On this computer or online?',
    blocks: [
      { p: 'On this computer: models in the LM Studio app translate right on your machine. It is free and the text never leaves your computer, so it suits confidential documents. It needs a more powerful computer and is slower.' },
      { p: 'Online: a model translates via the OpenRouter service. It is much faster and works on any computer, but the text is sent over the internet and paid from your credit (a typical article costs a fraction of a cent to a few cents). You need an API key from openrouter.ai, saved in Settings.' },
      { p: 'The Model row below the switch shows which model will be used; click it to change it. It also warns you if the API key is missing. The recommended online model is DeepSeek V4.1 Flash.' },
      { tip: 'A time and cost estimate appears at the bottom of the card as soon as you add a file; the actual cost is shown in the Information tab when it finishes.' },
    ],
  },
  {
    id: 'modes',
    title: 'Translation quality',
    blocks: [
      { p: 'The Quality option is only available when translating On this computer. Online always uses the best mode, so the row is not shown.' },
      {
        ul: [
          'Fast: text is taken straight from the PDF, OCR only for scanned pages. Errors are only flagged. Good for a quick overview.',
          'Balanced: an OCR model reads every page (better tables and reading order), the translation is checked and the issues found are fixed. Recommended.',
          'Best: first reads the beginning of the document to learn its topic, field and author (for correct grammatical gender and terminology). Slowest, most accurate.',
        ],
      },
      { p: 'The time-per-page estimate improves based on how fast your translations actually run.' },
    ],
  },
  {
    id: 'options',
    title: 'More options before translating',
    blocks: [
      {
        ul: [
          'Language: the source language is usually detected automatically. If the document is already in the target language, the app warns you.',
          'Extras, Tables and figures from the original: a table or figure with a caption (Table 1, Figure 2…) is not translated but inserted as an image of the original page; only the caption is translated. Recommended, so tables stay exactly as in the original.',
          'Extras, Choose paragraphs before translating: the app reads the document first and you tick the paragraphs to translate. The rest stays in the original; you can translate more later.',
          'Only some pages: shows a field for the PDF page range, e.g. 1-8 or 1-3, 5. Empty means the whole document.',
        ],
      },
    ],
  },
  {
    id: 'results',
    title: 'Document details',
    blocks: [
      { p: 'Clicking a document opens its details. At the top is a fixed bar: a back arrow, the name, the status and the Word and Open PDF buttons. The ⋯ menu has Save as, Show in folder, Rebuild PDF (builds the translated PDF again without a new translation), Translate again (in another mode), Translate more paragraphs (when something was left untranslated) and Delete from history.' },
      { p: 'Below the bar are tabs:' },
      {
        ul: [
          'Translation: the whole translated text as one document.',
          'Comparison: original and translation side by side, paragraph by paragraph. Spots worth checking (possible typo, untranslated word, missing glossary term) are highlighted; the “N to review” link at the top right takes you to the first one.',
          'Translated PDF: a translated PDF that looks like the original (same layout, images and tables).',
          'PDFs side by side: the original and the translated PDF next to each other, scrolling together.',
          'Original: the source file.',
          'Information: the model used, time, cost and processing notes.',
        ],
      },
      { p: 'The PDF tabs can be zoomed: pinch on a trackpad, Ctrl/Cmd with the mouse wheel, the keys Cmd/Ctrl with +, − or 0 (reset), or the floating control on the page.' },
      { tip: 'In the PDF tabs you can drag over an area of a page (such as a chart or an image with text) and have it translated separately.' },
    ],
  },
  {
    id: 'chat',
    title: 'Chat with the document',
    blocks: [
      { p: 'In a document’s details you can ask questions about its content. Open the chat with the button at the top right or the bar at the right edge. Drag its left edge to change the width, and use the same button to slide it away.' },
      { p: 'Answers come only from the document’s text. They carry source numbers [1], [2]…; clicking a number highlights the place in both the original and the translation. The Summarize and Key terms buttons ask the most common questions for you.' },
      { p: 'You choose the model at the bottom. On this computer: neither the document nor your questions leave your computer. Online: the question and the needed parts of the text are sent via OpenRouter, so an API key from Settings is required.' },
      { p: 'While answering you see the steps: loading the model, searching for keywords, the passages found and writing the answer.' },
      { p: 'How it works: a short document is read by the model in full. For a long one it first picks keywords from your question, finds the most relevant passages and answers from them. After the answer the citations are checked so they point to real places in the document.' },
      {
        ul: [
          'Study: “What are the author’s main arguments?”, “Explain the term X simply.”, “What method did the study use?”',
          'Contracts: “What is the notice period?”, “What penalties apply for delay?”, “What are the tenant’s obligations?”',
        ],
      },
      { tip: 'The chat is not legal or professional advice and the model can be wrong. Always verify important answers against the citations in the document.' },
      { p: 'The conversation is saved with the document and stays there when you reopen it. Use Clear conversation to remove it.' },
    ],
  },
  {
    id: 'interface',
    title: 'Interface and Settings',
    blocks: [
      {
        ul: [
          'The left panel collapses to icons only with the button at the top left; use the same button to expand it again.',
          'The connection status is at the bottom of the left panel (On this computer: LM Studio, Online: OpenRouter). Click it for details and to check again.',
          'Settings has the sections Appearance (app language and color theme: Light, Dark or System), Translation on this computer (LM Studio models), Online (OpenRouter: API key, model choice, price currency) and Advanced (notifications, layout-preserving PDF, unloading models).',
        ],
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    blocks: [
      { p: 'The glossary is a list of technical terms with their mandatory translations, e.g. “large language model = velký jazykový model”. You find it in the left panel. The app uses it for every translation and fixes or flags paragraphs where a term is missing.' },
      { tip: 'Enter the term as written in the original; the translation uses it in the grammatically correct form.' },
    ],
  },
  {
    id: 'updates',
    title: 'Updates',
    blocks: [
      { p: 'Once a day the app checks by itself whether a newer version is out. If so, a notice appears at the top with the buttons What’s new, Download and install and Later (hides the notice until the next launch). You can also check manually at the bottom of this page.' },
      { p: 'Windows: the installer is downloaded to your Downloads folder and started, and TransLatte quits; the installer installs the new version and starts the app again.' },
      { p: 'macOS: the installer disk image is downloaded and opened. Drag TransLatte into Applications to replace the old version, then start the app again. The Quit TransLatte button helps with that.' },
      { tip: 'If the download fails you get an error and a link to the release page, where you can download the file manually.' },
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
          'Out of credit or invalid key: the translation fails with an error; top up at openrouter.ai or save a new key and click Translate again.',
          'Scanned document: translate it with Balanced or Best quality (or Online) so the OCR model reads the page image.',
          'Jumbled text order or broken table: try Balanced quality, turn on Tables and figures from the original and check the spots highlighted in Comparison.',
          'Translated PDF missing: the reason is in the Information tab. Word and Comparison are always available.',
          'Chat does not answer: while a translation is running, the model may wait for it to finish. Check the model chosen at the bottom of the chat and, for Online, the API key.',
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
