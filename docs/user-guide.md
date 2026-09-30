# Planer postów LinkedIn w Claude Desktop – przewodnik użytkownika

Ten dokument opisuje, jak wygląda codzienna praca z planerem i co trzeba zrobić raz, żeby wszystko działało. Szczegóły techniczne są w [README](../README.md), a specyfikacja narzędzi w [mcp-tools-contract.md](mcp-tools-contract.md).

---

## 1. Jak to działa

Posty piszesz i planujesz w rozmowie z Claude Desktop. Claude pokazuje podgląd, a Ty go zatwierdzasz. Od tej chwili resztą zajmuje się program działający w tle na Twoim komputerze (**worker**):

1. o zaplanowanej godzinie publikuje post na Twoim profilu LinkedIn;
2. po kilku minutach dodaje pod nim Twój komentarz, np. z linkiem.

```
Ty ──rozmowa──> Claude Desktop ──> serwer „linkedin” ──> worker w tle ──o 8:00──> LinkedIn
                  (podgląd,                               (kolejka,          (post, potem
                   zatwierdzenie)                          harmonogram)       komentarz)
```

**Nic nie jest publikowane od razu.** Każdy post ma termin co najmniej 5 minut w przód i zawsze przechodzi przez podgląd oraz Twoje zatwierdzenie.

### Co warto wiedzieć od początku

| | |
|---|---|
| **Gdzie widać zaplanowane posty** | W Claude Desktop („pokaż kolejkę”) albo komendą `npm run status`. **Nie** w zakładce „Zaplanowane posty” na LinkedIn, bo API LinkedIn nie pozwala tam dodawać postów. Planer trzyma kolejkę u siebie i publikuje w wyznaczonej chwili, tak jak Buffer czy Hootsuite. |
| **Komputer** | Musi być włączony i zalogowany w chwili publikacji, bo worker działa lokalnie. |
| **Dokładność godziny** | Harmonogram sprawdza kolejkę co 5 minut (:00, :05, :10…). Termin 8:00 oznacza publikację o 8:00, a termin 8:02 publikację o 8:05, o czym podgląd uprzedza. |
| **Zdjęcia** | Jedno zdjęcie na post (JPG, PNG albo GIF). Trzeba podać **ścieżkę do pliku** na dysku. Obrazka wklejonego do czatu Claude nie może przekazać. |
| **Skąd planować** | Tylko z Claude Desktop na tym komputerze (nie z telefonu ani z claude.ai w przeglądarce). |
| **Logowanie do LinkedIn** | Ważne 60 dni, potem jedno kliknięcie, żeby je odnowić (patrz punkt 5). |

---

## 2. Jednorazowa konfiguracja

Każdy krok robisz tylko raz. Na końcu każdego jest sposób sprawdzenia, że się udał.

### Krok 1. Program na komputerze

Potrzebny jest Node.js 22 lub nowszy (`node -v`). W PowerShell:

```powershell
cd C:\Users\SzymonWarda\Documents\Projekt-mcp\LinkedIn-mcp
npm install
npm run build
```

✅ Sprawdzenie: `npm run doctor` wyświetla konfigurację bez błędów.

### Krok 2. Aplikacja w LinkedIn Developer Portal

Na [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) utwórz aplikację albo wybierz istniejącą. LinkedIn wymaga powiązania aplikacji ze stroną firmy, ale posty i tak pójdą z Twojego profilu osobistego.

1. Zakładka **Products**: dodaj
   - **Sign In with LinkedIn using OpenID Connect**,
   - **Share on LinkedIn**.
2. Zakładka **Auth → Authorized redirect URLs**: dodaj dokładnie
   `http://127.0.0.1:47811/oauth/callback`
3. Z zakładki **Auth** skopiuj **Client ID** i **Client Secret**.

### Krok 3. Plik `.env`

```powershell
copy .env.example .env
notepad .env
```

Uzupełnij:

```
LINKEDIN_CLIENT_ID=…            (z Developer Portal)
LINKEDIN_CLIENT_SECRET=…        (z Developer Portal – nikomu go nie pokazuj)
LINKEDIN_MODE=mock              (na razie atrapa; w kroku 7 zmienisz na live)
LINKEDIN_POST_VISIBILITY=PUBLIC (albo CONNECTIONS – tylko kontakty 1. stopnia)
```

Plik `.env` nie trafia do repozytorium. Sekretów nie wklejaj do czatu.

### Krok 4. Worker w tle i autostart

```powershell
npm run worker:start          # uruchom teraz
npm run autostart:install     # uruchamiaj sam po każdym zalogowaniu do Windows
```

✅ Sprawdzenie: `npm run worker:status` pokazuje `"running": true`.

### Krok 5. Podłączenie do Claude Desktop

```powershell
npm run claude-config -- --write
```

Komenda dopisuje serwer `linkedin` do konfiguracji Claude Desktop i robi kopię zapasową. Następnie **zamknij Claude Desktop całkowicie**: prawy przycisk na ikonie w zasobniku przy zegarze → **Quit**. Potem uruchom go ponownie.

✅ Sprawdzenie:
- **Settings → Developer** pokazuje `linkedin` ze statusem *running*;
- w nowej rozmowie **+ → Connectors** pokazuje `linkedin` jako włączony.

Nie używaj okna „Add custom connector”, bo służy do serwerów w internecie, a ten serwer jest lokalny.

### Krok 6. Logowanie do LinkedIn

Otwórz w przeglądarce **http://127.0.0.1:47811/oauth/start**, zaloguj się na LinkedIn i kliknij **Allow**.

✅ Sprawdzenie: strona pokazuje Twoje imię i nazwisko, datę ważności logowania i uprawnienia (`w_member_social`). Później stan sprawdzisz przez `npm run token:status`.

### Krok 7. Włączenie prawdziwej publikacji

Do tej chwili wszystko działa w **trybie atrapy**: przechodzi cały proces, ale nic nie trafia na LinkedIn. Gdy chcesz publikować naprawdę:

1. w `.env` zmień `LINKEDIN_MODE=mock` na `LINKEDIN_MODE=live`;
2. `npm run worker:restart`.

✅ Sprawdzenie: w Claude Desktop napisz „Sprawdź status LinkedIn”. Odpowiedź powinna zawierać `mode: live`, `connected: true` i Twój profil.

Posty zatwierdzone jeszcze w trybie atrapy **nie zostaną** opublikowane po przełączeniu. Dostaną status `failed` z kodem `mode_mismatch`. Zaplanuj je ponownie, jeśli mają się ukazać.

### Krok 8. Post testowy

Zaplanuj jeden krótki post za około 10 minut, z komentarzem po 1–2 minutach. Sprawdź na LinkedIn, czy post i komentarz się pojawiły. Post testowy usuniesz komendą:

```powershell
npm run cli -- linkedin delete-post <id-posta> --yes
```

Identyfikator posta zobaczysz w kolejce.

Po pierwszym komentarzu `can_comment` w statusie zmieni się z `unknown` na `yes` albo `no`. Wartość `no` oznacza, że aplikacja nie ma prawa komentować; komentarze będą wtedy pomijane, a posty nadal będą wychodzić.

---

## 3. Codzienna praca

Wszystko robisz w rozmowie z Claude Desktop, zwykłym językiem. Przykłady:

**Seria postów**
> Przygotuj serię 3 postów o NIS2 na poniedziałek, środę i piątek o 8:00. Pod każdym komentarz z zaproszeniem na webinar. Pokaż podgląd.

**Post ze zdjęciem**
> Zaplanuj post »…« na czwartek 9:00 ze zdjęciem "C:\Users\SzymonWarda\Pictures\nis2.png", tekst alternatywny: »Schemat obowiązków NIS2«.

Ścieżkę skopiujesz w Eksploratorze: Shift + prawy przycisk na pliku → **Kopiuj jako ścieżkę**.

**Link, który będzie później**
> Komentarz ma zawierać link do nagrania, które wrzucę później. Jeśli go nie podam, dodaj komentarz bez linku: »Nagranie wkrótce na profilu«.

Kiedy link będzie gotowy:
> Link do komentarza pod postem z czwartku: https://…

**Zmiany i kontrola**
> Pokaż kolejkę. · Przesuń środowy post na 10:30. · Zmień treść piątkowego posta na … · Anuluj post z czwartku. · Pokaż szczegóły i historię posta z poniedziałku.

### Jak wygląda zatwierdzanie

1. Claude wywołuje **podgląd**. Nic jeszcze nie jest zapisane.
2. Widzisz dla każdego posta:
   - godzinę publikacji (także faktyczną, jeśli wypada między przebiegami);
   - liczbę znaków, komentarz i zdjęcie;
   - **ostrzeżenia**, np. kolizja terminów, godzina przy zmianie czasu, brak tekstu alternatywnego;
   - **błędy**, np. termin za wcześnie, za długi post, duplikat.
3. Jeśli wszystko się zgadza, piszesz „zatwierdzam”. Claude zapisuje do kolejki **dokładnie** to, co widziałeś w podglądzie.
4. Podgląd jest ważny 30 minut. Później trzeba go wygenerować ponownie.

Zmienić lub anulować post możesz do 5 minut przed publikacją.

---

## 4. Co się dzieje po zatwierdzeniu

| Kiedy | Co się dzieje | Status w kolejce |
|---|---|---|
| Po zatwierdzeniu | post czeka w kolejce | `scheduled` |
| O godzinie publikacji (najbliższy przebieg co 5 min) | worker wysyła post (i zdjęcie) na LinkedIn | `publishing` → `published` + link do posta |
| Po opóźnieniu komentarza (domyślnie 10 min) | worker dodaje komentarz | komentarz: `waiting` → `done` |

Treść wychodzi dokładnie tak, jak w podglądzie, łącznie z nawiasami, gwiazdkami, polskimi znakami i emoji. Hashtagi `#słowo` są klikalne. Znak `@` jest zwykłym tekstem, więc wzmianki osób nie są tworzone.

---

## 5. Sytuacje szczególne

| Sytuacja | Co zobaczysz | Co zrobić |
|---|---|---|
| **Komputer był wyłączony w chwili publikacji** | Post spóźniony mniej niż 60 min wychodzi zaraz po starcie. Bardziej spóźniony ma status `missed`. | Poproś Claude'a o nowy termin dla tego posta (wraca wtedy do kolejki) albo go anuluj. |
| **Publikacja się nie udała, błąd jednoznaczny** (np. odmowa, brak połączenia) | status `failed`, opis w `last_error` | Post na pewno nie powstał. Zaplanuj go ponownie. |
| **Publikacja niepewna** (`ambiguous: true`, np. brak odpowiedzi LinkedIn po wysłaniu) | status `failed` z informacją „nie wiadomo, czy post powstał” | **Sprawdź swój profil na LinkedIn.** Planer celowo nie ponawia publikacji, żeby post nie ukazał się dwa razy. |
| **Brak uprawnień do komentarzy** | komentarz `skipped`, `can_comment: no` | Posty dalej wychodzą, tylko bez komentarza. Komentarz dodasz ręcznie. |
| **Link nie został podany na czas** | komentarz wychodzi w wersji bez linku albo jest pomijany | tak, jak ustaliłeś przy planowaniu |
| **Chcesz natychmiast wstrzymać wszystko** | – | `npm run pause -- "powód"`. Nic nie zostanie opublikowane do `npm run resume`. |
| **Logowanie LinkedIn wygasa (co 60 dni)** | Tydzień wcześniej status pokazuje ostrzeżenie „wygasa za N dni”. | Otwórz ponownie http://127.0.0.1:47811/oauth/start. Jeśli jesteś zalogowany na LinkedIn w przeglądarce, zajmie to kilka sekund. |
| **Claude mówi, że worker nie działa** | błąd `worker_not_running` z komendą | `npm run worker:start` |

---

## 6. Regularne czynności

- **Raz na około 2 miesiące:** odnowienie logowania LinkedIn (punkt 5).
- **Po planowaniu większej serii:** „pokaż kolejkę”, żeby sprawdzić godziny.
- **Czasem:** `npm run status` pokazuje wszystko naraz: worker, autostart, pauzę, najbliższe posty i posty wymagające uwagi.
- **Po zmianie `.env`:** `npm run worker:restart`.
- **Po aktualizacji programu:** `npm run build`, `npm run worker:restart` i ponowne uruchomienie Claude Desktop.

---

## 7. Ściąga komend

Uruchamiaj w PowerShell w folderze `C:\Users\SzymonWarda\Documents\Projekt-mcp\LinkedIn-mcp`.

| Komenda | Do czego |
|---|---|
| `npm run status` | pełny stan |
| `npm run worker:start` / `worker:stop` / `worker:restart` / `worker:status` | worker w tle |
| `npm run worker:logs` | ostatnie wpisy dziennika |
| `npm run autostart:install` / `autostart:uninstall` | start razem z Windows |
| `npm run pause -- "powód"` / `npm run resume` | bezpiecznik |
| `npm run token:status` | stan logowania LinkedIn (bez pokazywania tokenu) |
| `npm run login` | adres strony logowania |
| `npm run cli -- linkedin delete-post <id> --yes` | usunięcie opublikowanego posta z LinkedIn |
| `npm run cli -- token clear` | wylogowanie (usunięcie tokenu z komputera) |

---

## 8. Najczęstsze pytania

**Czy mogę zobaczyć zaplanowane posty w LinkedIn?**
Nie. API LinkedIn pozwala tylko opublikować post od razu, a nie dodać go do harmonogramu LinkedIn. Kolejkę widzisz w Claude Desktop.

**Czy mogę planować z telefonu?**
Nie w tej wersji. Wymagałoby to serwera w chmurze (np. Azure) z własnym logowaniem. Ten wariant został rozważony i na razie odłożony.

**Czy mogę wkleić zdjęcie do czatu?**
Claude je zobaczy i może pomóc w treści posta, ale nie przekaże pliku planerowi. Podaj ścieżkę do pliku na dysku.

**Co jeśli zmienię albo usunę plik zdjęcia po zatwierdzeniu?**
Nic się nie stanie. Planer zrobił kopię przy podglądzie i opublikuje dokładnie to zdjęcie, które zatwierdziłeś.

**Ile postów mogę zaplanować?**
LinkedIn pozwala na 150 wywołań API dziennie na konto. Jeden post to kilka wywołań (post, zdjęcie, komentarz), więc przy normalnym użyciu limit nie ma znaczenia.

**Czy ktoś inny może użyć planera na moim komputerze?**
Planer nasłuchuje tylko na adresie lokalnym komputera (127.0.0.1) i wymaga tajnego tokenu dostępu, zapisanego w Twoim profilu Windows. Token LinkedIn jest zaszyfrowany kluczem z Menedżera poświadczeń Windows.

**Jak wrócić do trybu testowego?**
`LINKEDIN_MODE=mock` w `.env` i `npm run worker:restart`.
