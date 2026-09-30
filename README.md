# LinkedIn MCP (lokalny)

Lokalny serwer MCP dla Claude Desktop. Publikuje zatwierdzone posty na profilu osobistym LinkedIn o zaplanowanej godzinie i dodaje pod nimi komentarz.
Rozmowa, redakcja i zatwierdzanie odbywają się w Claude Desktop. Serwer wykonuje tylko to, co zostało zatwierdzone.

- Specyfikacja narzędzi: [docs/mcp-tools-contract.md](docs/mcp-tools-contract.md)
- Wymagania projektu: [docs/build-prompt.md](docs/build-prompt.md)

## Jak to działa

```
Claude Desktop ──stdio──> mcp-stdio (nakładka) ──HTTP 127.0.0.1 + token──> worker (proces w tle)
                                                                            ├─ harmonogram Bree co 5 min
                                                                            ├─ baza SQLite (%LOCALAPPDATA%\linkedin-mcp)
                                                                            └─ klient LinkedIn (atrapa albo live)
```

- **worker** działa w tle niezależnie od Claude Desktop, przez cały czas zalogowania do Windows (po włączeniu autostartu).
- **mcp-stdio** to cienka nakładka uruchamiana przez Claude Desktop. Gdy worker nie działa, narzędzia zwracają błąd z komendą uruchomienia.
- **server-http** to wariant „wszystko w jednym” z transportem Streamable HTTP, pod późniejsze wdrożenie w Azure (etap 6).

Zasady:
- nie ma narzędzia do natychmiastowej publikacji, a termin musi być co najmniej 5 minut w przód;
- podgląd i zatwierdzenie idą osobno, a zatwierdzenie wymaga `plan_id` z podglądu;
- wszystkie porty nasłuchują tylko na 127.0.0.1;
- każda operacja trafia do dziennika audytu, bez sekretów.

## Wymagania

- Windows 10/11
- Node.js 22 lub nowszy (sprawdzone na 24.18, `C:\Program Files\nodejs\node.exe`)
- Claude Desktop

## Instalacja

```powershell
cd C:\Users\SzymonWarda\Documents\Projekt-mcp\LinkedIn-mcp
npm install
npm run build
npm test              # opcjonalnie: ponad 100 testów, kilka sekund
```

Konfiguracja jest opcjonalna, bo domyślne wartości wystarczą dla atrapy. Jeśli chcesz coś zmienić, skopiuj `.env.example` do `.env` i ustaw wartości. Plik `.env` jest w `.gitignore`.

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `LINKEDIN_MODE` | `mock` | `mock` (atrapa) albo `live` (prawdziwe LinkedIn, etap 5) |
| `WORKER_PORT` | `47811` | port lokalnego API workera (zawsze 127.0.0.1) |
| `SCHEDULER_INTERVAL_MIN` | `5` | co ile minut działa harmonogram (dzielnik 60) |
| `MISSED_GRACE_MIN` | `60` | spóźnienie, powyżej którego post dostaje status `missed` zamiast publikacji |
| `MIN_LEAD_MIN` | `5` | minimalne wyprzedzenie terminu (nie mniej niż 5) |
| `PLAN_TTL_MIN` | `30` | ważność `plan_id` z podglądu |
| `LINKEDIN_MCP_DATA_DIR` | `%LOCALAPPDATA%\linkedin-mcp` | baza, audyt, logi, flaga PAUSE, tokeny (musi być poza repozytorium) |

Po zmianie `.env` uruchom worker ponownie: `npm run worker:restart`.

## Uruchomienie workera

```powershell
npm run worker:start      # w tle, bez okna konsoli
npm run worker:status     # czy działa (PID, adres)
npm run worker:logs       # ostatnie linie worker.log
npm run worker:stop       # łagodne zatrzymanie
npm run worker:restart
npm run worker            # na pierwszym planie, z logiem w konsoli (Ctrl+C kończy)
npm run status            # pełny stan: worker, autostart, pauza, kolejka, konfiguracja Claude Desktop
```

Druga instancja workera nie wystartuje, bo chroni przed tym blokada w pliku `worker.pid`.

### Autostart przy logowaniu do Windows

```powershell
npm run autostart:install     # tworzy "LinkedIn MCP Worker.vbs" w folderze Autostart
npm run autostart:uninstall
```

Plik trafia do `shell:startup`, czyli `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`. Nie są potrzebne uprawnienia administratora. Po zalogowaniu skrypt uruchamia `worker start` bez okna konsoli. Jeśli przeniesiesz repozytorium albo zmienisz wersję Node, zainstaluj autostart jeszcze raz.

### Komputer był wyłączony

Pierwszy przebieg harmonogramu rusza od razu po starcie workera:
- post spóźniony o mniej niż 60 minut zostaje opublikowany;
- post spóźniony bardziej dostaje status `missed` i nie jest publikowany. Widać go w kolejce. Nadaj mu nowy termin przez `linkedin_update_post` (wraca wtedy do `scheduled`) albo go anuluj.

## Konfiguracja Claude Desktop

Claude Desktop na tym komputerze jest zainstalowany jako aplikacja MSIX (ze Sklepu), więc plik konfiguracji leży tutaj:

```
C:\Users\SzymonWarda\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

Instalator klasyczny używa `%APPDATA%\Claude\claude_desktop_config.json`. Komenda `npm run claude-config` sama wybiera właściwy plik.

**Automatycznie** (z kopią zapasową `.bak-…` obok pliku):

```powershell
npm run claude-config -- --write
```

**Ręcznie:** otwórz plik (w Claude Desktop: Settings → Developer → Edit Config) i dodaj sekcję `mcpServers`. Pozostałe klucze, np. `preferences`, zostaw bez zmian:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\SzymonWarda\\Documents\\Projekt-mcp\\LinkedIn-mcp\\dist\\mcp-stdio\\index.js"
      ]
    }
  }
}
```

Następnie **zamknij Claude Desktop całkowicie**, także ikonę w zasobniku systemowym (prawy przycisk → Quit), i uruchom go ponownie.

## Sprawdzenie w Claude Desktop (Connectors)

1. Upewnij się, że worker działa: `npm run worker:status`.
2. W Claude Desktop otwórz **Settings → Developer**. Serwer `linkedin` powinien mieć status *running*.
3. W nowej rozmowie otwórz menu narzędzi (przycisk **+** / „Search and tools”) → **Connectors**. Na liście powinien być `linkedin` z 8 narzędziami `linkedin_*` i musi być włączony.
4. Przykładowe polecenia:
   - „Sprawdź status połączenia z LinkedIn.” Oczekiwany wynik: `connected: true`, profil „Szymon Warda (atrapa)”, `can_comment: unknown`.
   - „Przygotuj podgląd dwóch postów: jutro o 8:00 i pojutrze o 8:00, z komentarzem pod każdym.” Claude wywoła `linkedin_preview_series` i pokaże podgląd.
   - „Zatwierdzam.” Claude wywoła `linkedin_commit_series`.
   - „Pokaż kolejkę.” / „Przesuń drugi post na 9:30.” / „Anuluj pierwszy post.”
5. Po terminie publikacji (i najbliższym przebiegu co 5 minut) post w kolejce ma status `published`, a 10 minut później komentarz ma `comment_status: done`. „Publikację” w atracie podejrzysz komendą `npm run cli -- mock posts`.

### Symulowanie błędów atrapy

```powershell
npm run cli -- mock set publish=timeout        # timeout po wysłaniu (niejednoznaczny, bez ponawiania)
npm run cli -- mock set publish=reject:1       # jednorazowa odmowa
npm run cli -- mock set publish=ambiguous      # zerwane połączenie po wysłaniu
npm run cli -- mock set comment=forbidden      # brak uprawnień do komentarza -> can_comment: no
npm run cli -- mock set auth=disconnected      # brak połączenia
npm run cli -- mock set delayMs=20000          # wolna odpowiedź (widać status publishing)
npm run cli -- mock show
npm run cli -- mock reset
```

Scenariusz jest czytany przy każdym wywołaniu, więc nie trzeba restartować workera.

## Bezpiecznik (PAUSE)

```powershell
npm run pause -- "urlop"   # harmonogram niczego nie publikuje ani nie komentuje
npm run resume
```

Pauza to plik `%LOCALAPPDATA%\linkedin-mcp\PAUSE`. Podczas pauzy posty spóźnione ponad próg nadal dostają `missed`, a `linkedin_auth_status` pokazuje ostrzeżenie.

## Przejście z atrapy na prawdziwe LinkedIn (etap 5)

Tryb live będzie działał po etapie 5. Wtedy:

1. W [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) aplikacja musi mieć produkty „Sign In with LinkedIn using OpenID Connect” oraz „Share on LinkedIn” (uprawnienie `w_member_social`), a także adres przekierowania `http://127.0.0.1:47811/oauth/callback`.
2. W `.env` ustaw `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` i **jawnie** `LINKEDIN_MODE=live`.
3. `npm run worker:restart`. Worker pokaże baner trybu live w logu.
4. Zaloguj się w przeglądarce pod adresem `login_url` z `linkedin_auth_status`, albo zaimportuj token wygenerowany w Developer Portal.
5. Najpierw zrób próbę na poście testowym. Na wszelki wypadek miej pod ręką `npm run pause`.

Powrót do atrapy: `LINKEDIN_MODE=mock` i `npm run worker:restart`.

## Rozwiązywanie problemów

| Objaw | Co zrobić |
|---|---|
| Narzędzie zwraca `worker_not_running` | `npm run worker:start`, potem `npm run worker:status`. Jeśli nie startuje: `npm run worker:logs`. |
| `Port 47811 na 127.0.0.1 jest zajęty` | Inny program zajmuje port. Ustaw inny `WORKER_PORT` w `.env`. Nakładka czyta ten sam `.env`, więc Claude Desktop nie wymaga zmian. |
| `Worker już działa (PID …)` | Worker już pracuje. `npm run worker:restart`, jeśli chcesz go uruchomić ponownie. |
| `worker_auth_failed` | Token workera się zmienił (np. po usunięciu pliku `worker-token`). Uruchom ponownie worker i Claude Desktop. |
| Claude Desktop nie widzi serwera `linkedin` | Sprawdź `npm run status` → `claude_desktop.serverConfigured`. Zamknij Claude Desktop także z zasobnika i uruchom ponownie. Logi Claude: `…\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs\mcp-server-linkedin.log`. |
| Serwer ma status *failed* w Settings → Developer | Najczęściej brakuje `dist` (uruchom `npm run build`) albo ścieżka w konfiguracji jest zła (`npm run claude-config -- --write`). |
| Post ma status `failed` z `ambiguous: true` | Nie wiadomo, czy post powstał. Sprawdź profil na LinkedIn. Serwer celowo nie ponawia, żeby nie było duplikatu. |
| Post ma status `missed` | Worker nie działał w terminie. Nadaj nowy termin przez `linkedin_update_post` albo anuluj post. |
| Post wyszedł kilka minut po terminie | Harmonogram działa co 5 minut. Termin 08:02 oznacza publikację o 08:05, o czym podgląd uprzedza ostrzeżeniem. |
| Autostart nie działa | `npm run autostart:install` jeszcze raz (np. po zmianie ścieżki repo lub wersji Node). Sprawdź plik w `shell:startup`. |

Pliki w `%LOCALAPPDATA%\linkedin-mcp\`:
- `linkedin-mcp.db`: baza;
- `audit.jsonl`: dziennik audytu;
- `worker.log` i `worker.out.log`: logi;
- `PAUSE`: flaga bezpiecznika;
- `worker-token`: lokalny token API;
- `mock-*.json`: stan i scenariusz atrapy.

## Testy i MCP Inspector

```powershell
npm test                  # buduje dist/ i uruchamia wszystkie testy
npm run inspector         # MCP Inspector w przeglądarce (worker musi działać)
npx -y @modelcontextprotocol/inspector --cli node dist/mcp-stdio/index.js --method tools/list
```

Przykładowe argumenty dla `linkedin_preview_series` w Inspectorze:

```json
{
  "posts": [
    { "text": "Pierwszy post #MCP", "publish_at": "2026-11-06T08:00:00", "comment_text": "Komentarz pod postem" },
    { "text": "Drugi post", "publish_at": "2026-11-07T08:00:00", "comment_text": "Więcej: [LINK]", "link_mode": "later", "if_no_link": "skip" }
  ]
}
```

## Struktura

```
src/core/          rdzeń: konfiguracja, model, baza (Store + SQLite), czas, harmonogram, serwis narzędzi, atrapa LinkedIn
src/worker/        proces w tle: Bree, lokalne API, sterowanie start/stop
src/mcp/           definicje narzędzi MCP (wspólne dla stdio i HTTP)
src/mcp-stdio/     nakładka stdio dla Claude Desktop
src/cli/           komendy: status, worker, autostart, claude-config, pause, mock
test/              testy (vitest)
docs/              kontrakt narzędzi i wymagania
```
