# TransLatte

Lokální překladač PDF a dokumentů. Překládá na tvém počítači přes modely v [LM Studiu](https://lmstudio.ai), takže text nikam neodchází. Výsledkem je dokument Word (.docx), text v Markdownu a u PDF i přeložené PDF, které vypadá jako originál.

## Co potřebuješ

- **macOS** (Apple Silicon i Intel) nebo **Windows 10/11** (x64 i ARM).
- **Mac s 16 GB+ paměti, nebo PC s grafikou s 8 GB+ VRAM a 16 GB+ RAM.** Podrobnosti v části [Požadavky na hardware](#požadavky-na-hardware).
- **Zhruba 20 GB volného místa** na modely.
- **LM Studio** se staženými modely (viz níže).

## Požadavky na hardware

Modely běží na grafice. V paměti je vždy jen jeden, aplikace je střídá podle fáze překladu. Každý 12B model potřebuje zhruba 9–11 GB: soubor modelu (7–8 GB) plus místo pro kontext, protože aplikace pracuje s kontextem 16 tisíc tokenů a posílá až 4 požadavky najednou.

| Počítač | Jak poběží |
| --- | --- |
| Mac s Apple Silicon a 24 GB+, PC s 16 GB+ VRAM | Doporučeno, model se vejde celý i s rezervou. |
| Mac s 16 GB, PC s 12 GB VRAM a 16 GB RAM | Funguje. Během překladu nepoužívej další náročné aplikace. |
| PC s 8 GB VRAM a 16–32 GB RAM | Funguje pomaleji, část modelu běží z RAM. |
| PC bez samostatné grafiky, Mac s 8 GB | Nevhodné. Jen na procesoru trvá několikastránkový dokument desítky minut. |

- **Mac:** grafika sdílí paměť se systémem a macOS jí nechá zhruba dvě třetiny až tři čtvrtiny. Proto je 16 GB minimum. Intel Macy s grafikou AMD nejsou vyzkoušené.
- **Windows:** LM Studio rozdělí model mezi grafiku a RAM samo. Když se model nenačte nebo systém začne být nepoužitelný, otevři v LM Studiu nastavení modelu (**My Models** → ozubené kolečko u modelu) a sniž **GPU Offload**. Méně vrstev na grafice znamená menší nároky na VRAM, ale pomalejší překlad.
- **Slabší a silnější počítače:** TranslateGemma existuje i ve velikosti 4B (pro 6–8 GB VRAM, horší kvalita) a 27B (pro 24 GB VRAM, lepší kvalita). Po stažení ji vyber v **Nastavení → Překlad**. Tyto velikosti zatím nejsou s TransLatte vyzkoušené.

Uvedené nároky jsou odhad. Ověřené jsou na MacBooku Air M-series s 16 GB.

## Instalace

### 1. LM Studio a modely

1. Stáhni a nainstaluj LM Studio z <https://lmstudio.ai> a jednou ho spusť.
2. V LM Studiu otevři vyhledávání modelů (lupa vlevo) a stáhni tyto modely:

   | K čemu | Model (hledej v LM Studiu) | Varianta | Velikost |
   | --- | --- | --- | --- |
   | Překlad | `mradermacher/translategemma-12b-it-GGUF` | Q4_K_S | 7,8 GB |
   | Opravy, kontext dokumentu a tabulky | `google/gemma-4-12b-qat` | Q4_0 | 7,2 GB |
   | Čtení stránek (OCR) | `sahilchachra/Unlimited-OCR-GGUF` | Q8_0 | 3,9 GB |

   Pro Rychlý režim u digitálních PDF stačí první dva. OCR model je potřeba pro skeny a pro Vyvážený a Kvalitní režim.
3. Modely nemusíš ručně načítat ani zapínat server. TransLatte si server spustí a modely načte samo, vždy jen ten, který právě potřebuje.

### 2. TransLatte

Instalátor stáhni z [Releases](https://github.com/Molyn597/TransLatte/releases).

- **macOS:** soubor `TransLatte-…-mac-universal.dmg`. Otevři ho a přetáhni TransLatte do Aplikací. Aplikace není podepsaná certifikátem Apple, proto ji poprvé otevři **pravým tlačítkem → Otevřít** a potvrď.
- **Windows:** soubor `TransLatte-…-win.exe`. Pokud Windows zobrazí „Systém Windows ochránil váš počítač“, klikni na **Další informace → Přesto spustit**. Aplikace se nainstaluje jen pro tvého uživatele a vytvoří zástupce na ploše.

### 3. První spuštění

Stav spojení s LM Studiem je vidět v levém panelu (položka **LM Studio**). V **Nastavení** je u každé role (OCR, Překlad, Opravy) vybraný model. Pokud jsi stáhl modely z tabulky, je vše nastavené. Adresu serveru (`http://localhost:1234`) měň jen tehdy, když máš LM Studio na jiném portu nebo počítači.

## Jak se překládá

1. Na záložce **Přeložit** přetáhni soubory (PDF, DOCX, TXT, MD), vyber jazyky a režim. U PDF můžeš omezit **Stránky PDF**, např. `1-5, 8`.
2. Úloha jde do fronty a průběh i odhad času vidíš v části **Probíhá**.
3. Hotový překlad najdeš v **Historii**. Detail úlohy má záložky:
   - **Srovnání:** originál a překlad po odstavcích, s upozorněními na možné chyby.
   - **Překlad:** jen přeložený text.
   - **Překlad PDF** a **PDF vedle sebe:** přeložené PDF se zachovaným vzhledem, samostatně nebo vedle originálu.
   - **Originál** a **Informace.**

   Tlačítka **Otevřít Word** a **Otevřít PDF** otevřou výsledné soubory.

### Režimy

| Režim | Co dělá | Kdy ho použít |
| --- | --- | --- |
| **Rychlý** | Text bere přímo z PDF, OCR jen u naskenovaných stránek. Chyby jen označí. | Běžné digitální PDF, výchozí volba. |
| **Vyvážený** | OCR všech stránek (lepší pořadí odstavců a tabulky), kontrola a oprava chyb. | Složitější rozvržení, tabulky. |
| **Kvalitní** | Navíc si přečte kontext dokumentu (téma, autor a jeho rod) pro přesnější opravy. | Texty, na kterých záleží. |

## Jak to funguje uvnitř

1. **Načtení:** z PDF se vezme text i rozvržení stránky (odstavce, nadpisy, tabulky, odkazy). Záhlaví, zápatí a čísla stránek se vynechají. Naskenované stránky přečte OCR model.
2. **Překlad:** TranslateGemma překládá po odstavcích, několik požadavků najednou. Data jako `03-10-2014` se nejdřív převedou na jednoznačný tvar, aby se nespletl den a měsíc.
3. **Kontrola:** bez modelu se hledají typické chyby: nepřeložená slova, chybějící termíny z glosáře, předložky (se/ze, ke/ve), pravopis přes slovník Hunspell a useknuté nebo opakující se věty. Slovník češtiny se stáhne při první kontrole.
4. **Oprava:** ve Vyváženém a Kvalitním režimu Gemma opraví jen odstavce s nalezenými chybami, ostatní nechá být.
5. **Zápis:** vznikne Word, Markdown a u PDF i přeložené PDF. V něm se původní text překryje barvou pozadí, překlad se vysází do stejného místa a odkazy zůstanou klikací.

Úlohy a výstupy jsou uložené ve složce aplikace:

- macOS: `~/Library/Application Support/TransLatte/jobs`
- Windows: `%APPDATA%\TransLatte\jobs`

## Glosář

Na záložce **Glosář** zadáš závazné překlady odborných termínů (např. *performance review → hodnocení výkonu*). Kontrola po překladu upozorní, když termín v překladu chybí, a oprava ho doplní.

## Časté potíže

- **„LM Studio není spuštěné a jeho příkaz „lms“ se nenašel“:** LM Studio není nainstalované, nebo ještě nebylo ani jednou spuštěné. Spusť ho a zkus to znovu.
- **„Model … se nepodařilo načíst“:** model není stažený, nebo se nevejde do paměti. Zkontroluj v LM Studiu, že je stažený, a zavři náročné aplikace.
- **Překlad je pomalý nebo se postupně zpomaluje:** u notebooků bez aktivního chlazení výkon při delší zátěži klesá. Pomůže připojit napájení a překládat po menších částech.
- **„Překlad se na stránce N nevešel do původního místa“:** český text bývá delší. V přeloženém PDF je písmo menší nebo text přesahuje, plný text je ve Wordu.
- **Odrážky z webových PDF jsou slité do jedné věty:** známé omezení. Pomůže Vyvážený režim s OCR.

## Vývoj

```bash
npm install
npm start          # build a spuštění z projektu
npm test           # testy (bez LLM)
npm run build      # jen build
```

Release vznikne pushnutím tagu se stejnou verzí jako v `package.json` (např. `v0.1.1`). GitHub Actions sestaví instalátory pro macOS a Windows a vydá je.
