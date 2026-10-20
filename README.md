<p align="center"><img src="build/icon.png" width="112" alt="" /></p>

# TransLatte

Lokální překladač PDF a dokumentů pro macOS a Windows. Čte digitální PDF i skeny, překládá je přes
modely ve tvém [LM Studiu](https://lmstudio.ai) a výsledek uloží jako Word. Nic neodchází na internet.

## Co umí

- **PDF i skeny**: digitální text čte z PDF, skeny přes OCR model. Dvousloupcové články čte po sloupcích.
- **Word, TXT a Markdown** jako vstup, **.docx** (a .md) jako výstup.
- **Tři režimy**, rychlost ↔ kvalita:
  | Režim | OCR | Překlad | Kontrola | Oprava chyb |
  | --- | --- | --- | --- | --- |
  | Rychlý | jen skeny, jinak text z PDF | TranslateGemma | ano | ne, chyby jen označí |
  | Vyvážený | všechny stránky s kontrolou | TranslateGemma | ano | Gemma 4 |
  | Kvalitní | všechny stránky s kontrolou | TranslateGemma | ano, navíc rod autora | Gemma 4 s kontextem dokumentu |
- **Kontrola kvality**: výstup OCR se porovnává s textovou vrstvou PDF. Když nesedí, stránka se čte znovu
  ve vyšším rozlišení, případně se použije text z PDF. Překlad se pak kontroluje odstavec po odstavci:
  pravopis (český slovník Hunspell, stáhne se při prvním použití), nepřeložená anglická slova, chybějící
  termíny z glosáře, opakování a podezřelá délka. U češtiny se navíc vždy opraví předložky („se zaměstnanci“)
  a pády měsíců. Vyvážený a Kvalitní režim nechají Gemmu opravit jen nalezené chyby; oprava se přijme,
  jen když změní nejvýš pár slov na chybu a chyb nepřibude. Co zůstane, je ve srovnání zvýrazněné.
- **Kontext dokumentu** (Kvalitní): před překladem Gemma přečte začátek dokumentu a zjistí téma, autora
  a jeho rod. Korektor dostane téma a autora, rod hlídá tvary jako „jsem uvedl / uvedla“. Vynucuje se
  jen tvůj glosář.
- **Tabulky**: Unlimited-OCR v LM Studiu ztrácí hranice buněk, proto tabulky přečte znovu vision model
  pro opravy z výřezu stránky.
- **Srovnání vedle sebe** (originál | překlad), náhled originálního PDF, historie s opakováním v jiném režimu.
- **Glosář** závazných termínů, výběr cílového jazyka, fronta s průběhem a odhadem času, notifikace,
  ikona v liště a průběh v Docku / na hlavním panelu.

## Co potřebuješ

1. **LM Studio** (Mac nebo Windows), aspoň jednou spuštěné, aby existoval příkaz `lms`.
2. Tři modely v LM Studiu (stažené přes vyhledávání v LM Studiu):
   | Role | Doporučený model | Klíč v LM Studiu |
   | --- | --- | --- |
   | OCR | Unlimited-OCR (GGUF, Q8) | `unlimited-ocr` |
   | Překlad | TranslateGemma 12B (Q4) | `translategemma-12b-it` |
   | Opravy, kontext a tabulky | Gemma 4 12B QAT (Q4) | `google/gemma-4-12b-qat` |

   Jiné modely jde vybrat v **Nastavení**. Model pro OCR i pro opravy musí umět obrázky (vision).
3. Paměť: modely se načítají po jednom, stačí **16 GB RAM** (Mac) nebo **GPU s 12 GB VRAM** (Windows).

Server LM Studia si TransLatte spustí samo, modely načítá a po dokončení uvolňuje. Jediné spojení
s internetem je jednorázové stažení českého slovníku pro kontrolu pravopisu; bez něj se pravopis přeskočí.

## Instalace

Stáhni instalátor ze stránky **Releases** tohoto repozitáře:

- **macOS**: `TransLatte-…-mac-universal.dmg`, přetáhni aplikaci do Aplikací. Aplikace nemá certifikát
  od Applu, takže ji poprvé otevři pravým tlačítkem → **Otevřít** → **Otevřít**.
- **Windows**: `TransLatte-…-win-x64.exe`. Když se objeví SmartScreen, klikni na **Další informace** →
  **Přesto spustit**.

## Používání

1. Přetáhni soubory do okna (nebo klikni a vyber je), zvol režim a jazyky.
2. Průběh vidíš v okně, v liště a v Docku. Okno můžeš zavřít, překlad doběhne na pozadí.
3. Po dokončení přijde notifikace. V detailu je srovnání, překlad, originál a tlačítka **Otevřít Word**,
   **Uložit jako…** a **Přeložit znovu** (v jiném režimu).

Data aplikace (historie, výsledky, glosář, nastavení) jsou v uživatelské složce:
`~/Library/Application Support/TransLatte` na Macu, `%APPDATA%\TransLatte` na Windows.

## Vývoj

```bash
npm install
npm start          # build a spuštění
npm test           # jednotkové testy (vitest)
npm run typecheck
npm run icons      # PNG ikony z build/icon.svg a build/tray.svg
npm run dist       # instalátor pro tento systém do release/
```

Struktura: `src/main` (fronta, pipeline, LM Studio, docx), `src/renderer` (UI a skryté okno s pdf.js),
`src/preload`, `src/shared` (typy), `test`.

## Vydání nové verze

Zvyš `version` v `package.json`, commitni a pushni tag se stejnou verzí:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

GitHub Actions sestaví instalátory pro macOS a Windows a vydají release.

## Plán

- **Fáze 2 (učení)**: překladová paměť z tvých oprav, automatický glosář, hodnocení
  odstavců, ruční oprava OCR, shrnutí dokumentu.
- **Fáze 3**: export oprav jako dataset pro doladění vlastního modelu.
