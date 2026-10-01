# Planer postów LinkedIn – przewodnik użytkownika

> **Stan dokumentu:** opisuje wersję docelową: aplikacja w Azure, podłączona do Claude jako konektor MCP. Kod jest gotowy i przetestowany, a wdrożenie opisuje [azure-deployment.md](azure-deployment.md). Wersja lokalna (worker na komputerze) służy do testów i opisuje ją [README](../README.md).

Ten dokument opisuje, jak wygląda codzienna praca z planerem i co trzeba zrobić raz, żeby wszystko działało. Specyfikacja narzędzi jest w [mcp-tools-contract.md](mcp-tools-contract.md).

---

## 1. Jak to działa

Posty piszesz i planujesz w rozmowie z Claude Desktop. Claude pokazuje podgląd, a Ty go zatwierdzasz. Zatwierdzona seria trafia do **aplikacji w Azure**, która działa całą dobę:

1. o zaplanowanej godzinie publikuje post **na stronie firmy KTBnet** (jako KTBnet, nie z Twojego profilu);
2. po kilku minutach dodaje pod nim komentarz, także jako KTBnet.

Z planera korzysta **zespół administratorów strony KTBnet**. Każda osoba loguje się swoim kontem LinkedIn, a wszyscy widzą wspólną kolejkę.

```
Claude Desktop ──konektor MCP (HTTPS)──> aplikacja w Azure ──o 8:00──> LinkedIn
 (rozmowa, podgląd,                       ├─ harmonogram (co 5 min)     (post, potem
  zatwierdzenie)                          ├─ baza PostgreSQL             komentarz)
                                          ├─ zdjęcia
                                          └─ zaszyfrowany token LinkedIn
```

**Nic nie jest publikowane od razu.** Każdy post ma termin co najmniej 5 minut w przód i zawsze przechodzi przez podgląd oraz Twoje zatwierdzenie.

### Co warto wiedzieć od początku

| | |
|---|---|
| **Komputer** | Potrzebny tylko do rozmowy z Claude. **O godzinie publikacji może być wyłączony**, bo publikuje Azure. |
| **Gdzie widać zaplanowane posty** | W Claude („pokaż kolejkę”). **Nie** w zakładce „Zaplanowane posty” na LinkedIn, bo API LinkedIn nie pozwala tam dodawać postów. Planer trzyma kolejkę u siebie i publikuje w wyznaczonej chwili, tak jak Buffer czy Hootsuite. |
| **Dokładność godziny** | Harmonogram sprawdza kolejkę co 5 minut (:00, :05, :10…). Termin 8:00 oznacza publikację o 8:00, a termin 8:02 publikację o 8:05, o czym podgląd uprzedza. |
| **Zdjęcia** | Jedno zdjęcie na post (JPG, PNG albo GIF), wysyłane przez **jednorazowy link**, który podaje Claude (punkt 3). Samego obrazka wklejonego do czatu Claude nie może przekazać aplikacji. |
| **Kto może korzystać** | Osoby z rolą **Super admin** (`ADMINISTRATOR`) albo **Content admin** (`CONTENT_ADMINISTRATOR`) na stronie KTBnet. Planer sprawdza to w LinkedIn przy logowaniu, potem co godzinę i raz dziennie. Odebranie roli na LinkedIn odbiera też dostęp do planera. |
| **Logowanie** | Każda osoba łączy konektor swoim kontem LinkedIn. Logowanie jest ważne 60 dni. |
| **Wspólna kolejka** | Każdy widzi i może zmieniać wszystkie posty. Przy poście widać, kto go utworzył i kto ostatnio zmienił. |
| **Gdy komuś wygaśnie logowanie** | Post i tak wyjdzie, tokenem innego administratora. Komentarz jako strona idzie tokenem osoby z rolą Super admin, bo Content admin nie może komentować w imieniu strony. Dlatego **co najmniej jedna osoba z rolą Super admin** powinna mieć ważne logowanie. |
| **Skąd planować** | Z Claude Desktop. Ten sam konektor zadziała też na claude.ai i w aplikacji Claude na telefonie, jeśli kiedyś zechcesz. |

---

## 2. Jednorazowa konfiguracja

### Krok 1. Aplikacja w LinkedIn Developer Portal

Publikowanie w imieniu strony firmy wymaga produktu **Community Management API**, który LinkedIn przyznaje po weryfikacji wniosku:

1. Utwórz **nową** aplikację na [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps), powiązaną ze stroną KTBnet (nazwa bez słów „LinkedIn”, „Linked”, „In”). **Nie dodawaj do niej innych produktów**, bo wniosek o Community Management API można złożyć tylko dla aplikacji bez innych produktów.
2. **Settings → Verify → Generate URL**: link otwiera i zatwierdza super admin strony KTBnet.
3. **Products → Community Management API → Request access**: podaj firmowy e-mail (`@ktbnet.pl`), dane firmy, politykę prywatności i zastosowanie **Page Management**. Poczekaj na decyzję LinkedIn.
4. Po zatwierdzeniu sprawdź w zakładce **Auth**, jakie uprawnienia ma aplikacja. Potrzebne są `r_organization_admin` i `w_organization_social`; jeśli są też `r_basicprofile` i `w_organization_social_feed`, dopisz je w konfiguracji (`LINKEDIN_SCOPES`).
5. Zakładka **Auth → Authorized redirect URLs**: dodaj adres aplikacji w Azure, np.
   `https://linkedin-mcp.<region>.azurecontainerapps.io/oauth/callback`
   Dokładny adres pojawi się po wdrożeniu w kroku 2.

### Krok 2. Wdrożenie w Azure

Robi się to raz, według [azure-deployment.md](azure-deployment.md). Powstają:

| Zasób | Po co |
|---|---|
| **Azure Container Apps** (1 stale działająca instancja) | aplikacja i harmonogram, adres HTTPS |
| **Azure Database for PostgreSQL** | kolejka postów, historia, zdjęcia, zaszyfrowany token |
| **Key Vault** | Client Secret LinkedIn i klucz szyfrowania |
| **Monitoring** (Azure Monitor) | dziennik i alerty e-mail o błędach publikacji oraz wygasającym logowaniu |

Przy wdrożeniu ustawiasz Client ID i Client Secret z kroku 1, **numer strony KTBnet** (`LINKEDIN_ORGANIZATION_ID`, widoczny w adresie panelu administracyjnego strony: `linkedin.com/company/<numer>/admin`), strefę czasową (domyślnie Europe/Warsaw) i tryb: najpierw `mock` (atrapa), potem `live`.

✅ Sprawdzenie: adres `https://…/api/health` w przeglądarce odpowiada `"ok": true`.

### Krok 3. Dodanie konektora w Claude Desktop

1. **Settings → Connectors → Add custom connector**.
2. Nazwa: np. `LinkedIn`. Adres: `https://linkedin-mcp.<region>.azurecontainerapps.io/mcp`.
3. **Add**, potem **Connect**. Otworzy się logowanie LinkedIn: zaloguj się **swoim** kontem i kliknij **Allow**.
4. Wróć do Claude. Konektor ma status „połączony”.

Przy planie Claude Enterprise konektor może dodać administrator organizacji Claude raz dla wszystkich. Każda z osób klika wtedy tylko **Connect** i loguje się swoim LinkedIn.

✅ Sprawdzenie: w nowej rozmowie **+ → Connectors** pokazuje konektor LinkedIn jako włączony. Na polecenie „Sprawdź status LinkedIn” Claude pokazuje stronę KTBnet, Twoje role, ważność Twojego logowania i listę osób z zespołu, które są połączone.

Jeśli wcześniej był podłączony lokalny serwer `linkedin` (wersja testowa), usuń go z konfiguracji Claude Desktop, żeby nie mieć dwóch podobnych narzędzi.

### Krok 4. Test w trybie atrapy, potem przełączenie na prawdziwe LinkedIn

1. W trybie `mock` zaplanuj próbną serię i sprawdź kolejkę oraz „publikację” (nic nie trafia na LinkedIn).
2. Przełącz aplikację na `live` według instrukcji w README. Posty zatwierdzone w trybie atrapy **nie zostaną** opublikowane: dostaną status `failed` z kodem `mode_mismatch`.
3. Zaplanuj jeden krótki post testowy za około 10 minut, z komentarzem po 1–2 minutach. Sprawdź go na LinkedIn. Post testowy usuniesz ręcznie na LinkedIn (menu „…” przy poście → Usuń).

Po pierwszym komentarzu `can_comment` w statusie zmieni się z `unknown` na `yes` albo `no`. Wartość `no` oznacza, że aplikacja nie ma prawa komentować; komentarze będą wtedy pomijane, a posty nadal będą wychodzić.

---

## 3. Codzienna praca

Wszystko robisz w rozmowie z Claude, zwykłym językiem.

**Seria postów**
> Przygotuj serię 3 postów o NIS2 na poniedziałek, środę i piątek o 8:00. Pod każdym komentarz z zaproszeniem na webinar. Pokaż podgląd.

**Post ze zdjęciem**
> Zaplanuj post »…« na czwartek 9:00 ze zdjęciem. Tekst alternatywny: »Schemat obowiązków NIS2«.

1. Claude podaje **link do przesłania zdjęcia**, ważny 15 minut.
2. Klikasz go. Otwiera się strona z przyciskiem **Wybierz zdjęcie**: wybierasz plik z dysku (albo z galerii i aparatu na telefonie) i wysyłasz.
3. Strona pokazuje miniaturkę i „gotowe”. Piszesz Claude'owi „wysłane”.
4. Claude robi podgląd posta z tym zdjęciem.

**Link, który będzie później**
> Komentarz ma zawierać link do nagrania, które wrzucę później. Jeśli go nie podam, dodaj komentarz bez linku: »Nagranie wkrótce na profilu«.

Kiedy link będzie gotowy:
> Link do komentarza pod postem z czwartku: https://…

**Zmiany i kontrola**
> Pokaż kolejkę. · Przesuń środowy post na 10:30. · Zmień treść piątkowego posta na … · Zmień zdjęcie w poście z czwartku. · Anuluj post z czwartku. · Pokaż szczegóły i historię posta z poniedziałku.

### Jak wygląda zatwierdzanie

1. Claude wywołuje **podgląd**. Nic jeszcze nie jest zapisane.
2. Widzisz dla każdego posta:
   - godzinę publikacji (także faktyczną, jeśli wypada między przebiegami);
   - liczbę znaków, komentarz i zdjęcie (nazwa, rozmiar, wymiary);
   - **ostrzeżenia**, np. kolizja terminów, godzina przy zmianie czasu, brak tekstu alternatywnego;
   - **błędy**, np. termin za wcześnie, za długi post, duplikat.
3. Jeśli wszystko się zgadza, piszesz „zatwierdzam”. Claude zapisuje do kolejki **dokładnie** to, co widziałeś w podglądzie.
4. Podgląd jest ważny 30 minut. Później trzeba go wygenerować ponownie.

Zmienić lub anulować post możesz do 5 minut przed publikacją.

---

## 4. Co się dzieje po zatwierdzeniu

| Kiedy | Co się dzieje | Status w kolejce |
|---|---|---|
| Po zatwierdzeniu | post czeka w kolejce w Azure | `scheduled` |
| O godzinie publikacji (najbliższy przebieg co 5 min) | aplikacja wysyła post (i zdjęcie) na LinkedIn | `publishing` → `published` + link do posta |
| Po opóźnieniu komentarza (domyślnie 10 min) | aplikacja dodaje komentarz | komentarz: `waiting` → `done` |

Treść wychodzi dokładnie tak, jak w podglądzie, łącznie z nawiasami, gwiazdkami, polskimi znakami i emoji. Hashtagi `#słowo` są klikalne. Znak `@` jest zwykłym tekstem, więc wzmianki osób nie są tworzone.

---

## 5. Sytuacje szczególne

| Sytuacja | Co zobaczysz | Co zrobić |
|---|---|---|
| **Publikacja się nie udała, błąd jednoznaczny** (np. odmowa LinkedIn) | status `failed`, opis w `last_error`, alert e-mail | Post na pewno nie powstał. Zaplanuj go ponownie. |
| **Publikacja niepewna** (`ambiguous: true`, np. brak odpowiedzi LinkedIn po wysłaniu) | status `failed` z informacją „nie wiadomo, czy post powstał”, alert e-mail | **Sprawdź swój profil na LinkedIn.** Aplikacja celowo nie ponawia publikacji, żeby post nie ukazał się dwa razy. |
| **Aplikacja w Azure nie działała w terminie** (np. awaria, restart) | spóźnienie poniżej 60 min: post wychodzi po wznowieniu; powyżej: status `missed` | Poproś Claude'a o nowy termin dla tego posta albo go anuluj. |
| **Brak uprawnień do komentarzy** | komentarz `skipped`, `can_comment: no` | Posty dalej wychodzą, tylko bez komentarza. Sprawdź, czy osoba z rolą Super admin ma ważne logowanie (status pokazuje zespół). Komentarz dodasz ręcznie. |
| **Nikt z zespołu nie ma ważnego logowania** | ostrzeżenie w statusie, alert e-mail, posty dostają `failed` | Ktokolwiek z administratorów łączy konektor ponownie; nieopublikowane posty przeplanuj. |
| **Ktoś odszedł z zespołu** | – | Odbierz mu rolę na stronie KTBnet; planer sam odetnie dostęp najpóźniej przy następnym sprawdzeniu. Od razu: `npm run cli -- server users block <osoba>`. |
| **Link nie został podany na czas** | komentarz wychodzi w wersji bez linku albo jest pomijany | tak, jak ustaliłeś przy planowaniu |
| **Chcesz natychmiast wstrzymać publikację** | – | Komenda administracyjna `npm run cli -- server pause "powód"` (z dostępem do bazy, patrz [azure-deployment.md](azure-deployment.md), punkt 9). Nic nie wyjdzie do `server resume`. Pojedynczy post anulujesz w Claude („anuluj post z czwartku”). |
| **Logowanie LinkedIn wygasa (co 60 dni, osobno dla każdej osoby)** | Tydzień wcześniej status i alert e-mail „wygasa za N dni”. | W Claude Desktop: **Settings → Connectors → LinkedIn → Connect** (ponowne logowanie). Kolejka zostaje nietknięta. |
| **Link do zdjęcia wygasł** | strona „link wygasł” | Poproś Claude'a o nowy link. |

---

## 6. Regularne czynności

- **Raz na około 2 miesiące:** ponowne połączenie konektora (punkt 5).
- **Po planowaniu większej serii:** „pokaż kolejkę”, żeby sprawdzić godziny.
- **Gdy przyjdzie alert e-mail:** „pokaż posty wymagające uwagi” (statusy `failed` i `missed`).

---

## 7. Najczęstsze pytania

**Czy komputer musi być włączony o godzinie publikacji?**
Nie. Publikuje aplikacja w Azure. Komputer jest potrzebny tylko do rozmowy z Claude.

**Czy mogę zobaczyć zaplanowane posty w LinkedIn?**
Nie. API LinkedIn pozwala tylko opublikować post od razu, a nie dodać go do harmonogramu LinkedIn. Kolejkę widzisz w Claude.

**Dlaczego zdjęcie wysyłam przez link, a nie wklejam do czatu?**
Claude widzi wklejony obraz, ale nie może przekazać pliku do konektora. Link otwiera stronę aplikacji, na którą wysyłasz plik bezpośrednio. Link jest jednorazowy i ważny 15 minut, więc nikt obcy nic przez niego nie prześle.

**Co jeśli po zatwierdzeniu zmienię albo usunę plik zdjęcia na dysku?**
Nic się nie stanie. Aplikacja ma własną kopię i opublikuje dokładnie to zdjęcie, które zatwierdziłeś.

**Kto może planować posty na stronie KTBnet?**
Tylko administratorzy strony KTBnet z rolą Super admin albo Content admin. LinkedIn potwierdza rolę przy logowaniu, a planer sprawdza ją ponownie co godzinę i raz dziennie. Komuś, komu odbierzecie rolę na stronie, planer sam odetnie dostęp. Konto można też zablokować od razu komendą `npm run cli -- server users block <osoba>`. Tokeny LinkedIn są zaszyfrowane, a klucz leży w Key Vault. Tokenu nie zwraca żadne narzędzie.

**Ile postów mogę zaplanować?**
LinkedIn pozwala na 150 wywołań API dziennie na konto. Jeden post to kilka wywołań (post, zdjęcie, komentarz), więc przy normalnym użyciu limit nie ma znaczenia.

**Czy mogę planować z telefonu?**
Tak, ten sam konektor działa na claude.ai i w aplikacji Claude na telefonie. Zdjęcie wybierasz wtedy przez link z galerii albo aparatu.

**Ile to kosztuje?**
Głównie Azure: stale działająca mała instancja Container Apps i najmniejszy serwer PostgreSQL. To orientacyjnie kilkadziesiąt złotych miesięcznie, a dokładną kwotę pokaże kalkulator Azure dla wybranego regionu. Nowe konta Azure mają zwykle darmowy pierwszy rok dla małego PostgreSQL.
