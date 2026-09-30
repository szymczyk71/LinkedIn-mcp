# LinkedIn MCP (lokalny)

Lokalny serwer MCP, który publikuje zaplanowane posty na profilu osobistym LinkedIn i dodaje pod nimi komentarze.
Specyfikacja narzędzi: [docs/mcp-tools-contract.md](docs/mcp-tools-contract.md). Wymagania: [docs/build-prompt.md](docs/build-prompt.md).

> Projekt w budowie. Pełne README (worker w tle, Claude Desktop, autostart, przejście na live) pojawi się w etapie 4.

## Szybki start (etap 1)

```powershell
npm install
npm run build
npm test
npm run doctor              # konfiguracja, ścieżki, stan bazy
npm run cli -- mock set publish=timeout:1
npm run pause -- "urlop"    # bezpiecznik
npm run resume
```

Dane (baza SQLite, audyt, flaga PAUSE, tokeny) leżą w `%LOCALAPPDATA%\linkedin-mcp\`, czyli poza repozytorium.
