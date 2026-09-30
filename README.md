# LinkedIn MCP (lokalny)

Lokalny serwer MCP, który publikuje zaplanowane posty na profilu osobistym LinkedIn i dodaje pod nimi komentarze.
Specyfikacja narzędzi: [docs/mcp-tools-contract.md](docs/mcp-tools-contract.md). Wymagania: [docs/build-prompt.md](docs/build-prompt.md).

> Projekt w budowie. Pełne README (worker w tle, Claude Desktop, autostart, przejście na live) pojawi się w etapie 4.

## Szybki start (etapy 1-3)

```powershell
npm install
npm run build
npm test
npm run doctor              # konfiguracja, ścieżki, stan bazy
npm run cli -- mock set publish=timeout:1
npm run pause -- "urlop"    # bezpiecznik
npm run resume
npm run worker              # worker na pierwszym planie (Ctrl+C kończy)
```

Harmonogram działa co 5 minut (`SCHEDULER_INTERVAL_MIN`), wyrównany do zegara. Post zaplanowany na 08:02 wyjdzie o 08:05.

Dane (baza SQLite, audyt, flaga PAUSE, tokeny) leżą w `%LOCALAPPDATA%\linkedin-mcp\`, czyli poza repozytorium.

## Sprawdzenie w MCP Inspector (etap 3)

1. W pierwszym oknie PowerShell uruchom worker: `npm run worker`.
2. W drugim oknie: `npm run inspector`. Otworzy się przeglądarka z MCP Inspector, a serwer stdio jest już wpisany.
3. Kliknij **Connect**, potem **Tools → List Tools**. Powinno być 8 narzędzi `linkedin_*`.
4. Wywołaj `linkedin_auth_status` (tryb atrapy: `connected: true`, `can_comment: "unknown"`).
5. Wywołaj `linkedin_preview_series` z serią w postaci JSON, a potem `linkedin_commit_series` z `plan_id`. Na koniec `linkedin_list_queue`.

Przykładowe argumenty dla `linkedin_preview_series`:

```json
{
  "posts": [
    { "text": "Pierwszy post #MCP", "publish_at": "2026-11-06T08:00:00", "comment_text": "Komentarz pod postem" },
    { "text": "Drugi post", "publish_at": "2026-11-07T08:00:00", "comment_text": "Więcej: [LINK]", "link_mode": "later", "if_no_link": "skip" }
  ]
}
```

Wersja bez przeglądarki:

```powershell
npx -y @modelcontextprotocol/inspector --cli node dist/mcp-stdio/index.js --method tools/list
npx -y @modelcontextprotocol/inspector --cli node dist/mcp-stdio/index.js --method tools/call --tool-name linkedin_auth_status
```

Gdy worker nie działa, każde narzędzie zwraca błąd `worker_not_running` z komendą uruchomienia.
