# Wdrożenie w Azure (wariant server-http)

Instrukcja zakłada **jedno wdrożenie dla jednej osoby**: aplikacja w Azure Container Apps (jedna, stale działająca replika z harmonogramem), baza Azure Database for PostgreSQL i sekrety w Key Vault. Opis korzystania z aplikacji jest w [user-guide.md](user-guide.md).

> Polecenia są przykładowe. Przed uruchomieniem sprawdź nazwy, region i ceny w [kalkulatorze Azure](https://azure.microsoft.com/pricing/calculator/). Nic nie powstaje, dopóki sam nie wykonasz poleceń.

## Co powstaje

| Zasób | Po co | Ustawienia |
|---|---|---|
| Resource group | kontener na wszystko | – |
| Azure Database for PostgreSQL – Flexible Server | kolejka, historia, zdjęcia, zaszyfrowany token LinkedIn, dane logowania konektora | Burstable B1ms, 32 GB |
| Key Vault | Client Secret LinkedIn, klucz szyfrowania, adres bazy | RBAC |
| Container Registry (Basic) | obraz aplikacji | alternatywa: publiczny obraz w GitHub Container Registry |
| Container Apps Environment + Container App | aplikacja i harmonogram, publiczny HTTPS | **min 1 / max 1 replika**, port 8080 |
| Log Analytics (tworzony ze środowiskiem) | dziennik i alerty | – |

Dlaczego dokładnie jedna replika:
- **Minimum 1:** harmonogram działa w procesie aplikacji. Przy zerze replik aplikacja by się usypiała i nic nie wychodziłoby o czasie.
- **Maksimum 1:** jedna instancja wystarczy. Podwójnej publikacji i tak zapobiega blokada wiersza w bazie.

## 0. Przygotowanie

```powershell
az login
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights

$RG = "rg-linkedin-mcp"
$LOC = "polandcentral"            # albo westeurope
$SUFFIX = "sw$(Get-Random -Maximum 9999)"
$PG = "pg-linkedin-mcp-$SUFFIX"
$KV = "kv-linkedin-$SUFFIX"
$ACR = "acrlinkedin$SUFFIX"
$ENV = "cae-linkedin-mcp"
$APP = "linkedin-mcp"
$PG_ADMIN = "linkedinadmin"
$PG_PASS = [Convert]::ToBase64String([byte[]](1..24 | ForEach-Object { Get-Random -Maximum 256 }))  # zapisz w bezpiecznym miejscu

az group create -n $RG -l $LOC
```

## 1. PostgreSQL

```powershell
az postgres flexible-server create -g $RG -n $PG -l $LOC `
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 `
  --admin-user $PG_ADMIN --admin-password $PG_PASS `
  --public-access 0.0.0.0            # dostęp tylko z usług Azure (Container Apps)
az postgres flexible-server db create -g $RG -s $PG -d linkedin_mcp
```

Adres bazy (połączenie szyfrowane):

```powershell
$DATABASE_URL = "postgres://${PG_ADMIN}:$([uri]::EscapeDataString($PG_PASS))@$PG.postgres.database.azure.com:5432/linkedin_mcp?sslmode=require"
```

Schemat bazy tworzy się sam przy pierwszym starcie aplikacji.

## 2. Key Vault i sekrety

```powershell
az keyvault create -g $RG -n $KV -l $LOC --enable-rbac-authorization true
$ME = az ad signed-in-user show --query id -o tsv
$KV_ID = az keyvault show -n $KV --query id -o tsv
az role assignment create --assignee $ME --role "Key Vault Secrets Officer" --scope $KV_ID

$ENC_KEY = [Convert]::ToBase64String([byte[]](1..32 | ForEach-Object { Get-Random -Maximum 256 }))
az keyvault secret set --vault-name $KV -n linkedin-client-secret --value "<Client Secret z Developer Portal>"
az keyvault secret set --vault-name $KV -n token-encryption-key  --value $ENC_KEY
az keyvault secret set --vault-name $KV -n database-url          --value $DATABASE_URL
```

Klucz `token-encryption-key` szyfruje token LinkedIn w bazie. Jego zmiana oznacza konieczność ponownego połączenia konektora.

## 3. Obraz aplikacji

**Wariant A: Azure Container Registry.** Budowanie odbywa się w chmurze, nie potrzeba lokalnego Dockera.

```powershell
az acr create -g $RG -n $ACR --sku Basic
az acr build -r $ACR -t linkedin-mcp:1 .          # w katalogu repozytorium
$IMAGE = "$ACR.azurecr.io/linkedin-mcp:1"
```

**Wariant B: GitHub Container Registry (darmowy)**, np. z GitHub Actions albo lokalnie przez `docker build` i `docker push ghcr.io/<konto>/linkedin-mcp:1`. Obraz nie zawiera żadnych sekretów, więc może być publiczny. Wtedy `$IMAGE = "ghcr.io/<konto>/linkedin-mcp:1"` i w kroku 4 pomijasz `--registry-*`.

## 4. Container App

```powershell
az containerapp env create -g $RG -n $ENV -l $LOC

az containerapp create -g $RG -n $APP --environment $ENV `
  --image $IMAGE --registry-server "$ACR.azurecr.io" --registry-identity system `
  --system-assigned --ingress external --target-port 8080 `
  --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi `
  --env-vars LINKEDIN_MODE=mock DEFAULT_TIMEZONE=Europe/Warsaw LINKEDIN_CLIENT_ID="<Client ID>" LINKEDIN_POST_VISIBILITY=PUBLIC
```

Nadaj tożsamości aplikacji prawo odczytu sekretów:

```powershell
$APP_PRINCIPAL = az containerapp show -g $RG -n $APP --query identity.principalId -o tsv
az role assignment create --assignee $APP_PRINCIPAL --role "Key Vault Secrets User" --scope $KV_ID
```

Podłącz sekrety z Key Vault i ustaw adres publiczny:

```powershell
$FQDN = az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv
$KVURI = "https://$KV.vault.azure.net/secrets"

az containerapp secret set -g $RG -n $APP --secrets `
  "li-secret=keyvaultref:$KVURI/linkedin-client-secret,identityref:system" `
  "enc-key=keyvaultref:$KVURI/token-encryption-key,identityref:system" `
  "db-url=keyvaultref:$KVURI/database-url,identityref:system"

az containerapp update -g $RG -n $APP --set-env-vars `
  LINKEDIN_CLIENT_SECRET=secretref:li-secret `
  LINKEDIN_MCP_ENC_KEY=secretref:enc-key `
  DATABASE_URL=secretref:db-url `
  PUBLIC_BASE_URL="https://$FQDN"
```

✅ Sprawdzenie: `https://<FQDN>/api/health` zwraca `"ok": true`, a `az containerapp logs show -g $RG -n $APP --follow` pokazuje „server-http nasłuchuje” i „Harmonogram uruchomiony”.

## 5. LinkedIn Developer Portal

W aplikacji LinkedIn, w zakładce **Auth → Authorized redirect URLs**, dodaj:

```
https://<FQDN>/oauth/callback
```

Produkty (zakładka **Products**) pozostają te same: *Sign In with LinkedIn using OpenID Connect* i *Share on LinkedIn*.

## 6. Konektor w Claude

1. Claude Desktop (albo claude.ai): **Settings → Connectors → Add custom connector**.
2. Adres: `https://<FQDN>/mcp`, potem **Add** → **Connect**.
3. Ekran aplikacji pokaże, dokąd trafi dostęp (`claude.ai`). Kliknij **Kontynuuj przez LinkedIn**, zaloguj się i kliknij **Allow**.

**Pierwsze konto LinkedIn, które się połączy, zostaje właścicielem planera.** Każde inne dostanie odmowę. Połącz się więc od razu po wdrożeniu.

Przepływ OAuth spełnia wymagania Claude: Dynamic Client Registration, PKCE S256, odpowiedź 401 z `resource_metadata`, adres zwrotny `https://claude.ai/api/mcp/auth_callback` i rotacja tokenów odświeżania. Działa też z Claude Code i MCP Inspector (adresy lokalne z dowolnym portem).

## 7. Tryb live

Najpierw przetestuj w trybie `mock`. Gdy wszystko działa:

```powershell
az containerapp update -g $RG -n $APP --set-env-vars LINKEDIN_MODE=live
```

Posty zatwierdzone w trybie atrapy nie zostaną opublikowane (`mode_mismatch`).

## 8. Alerty (Azure Monitor)

Aplikacja zapisuje dziennik jako JSON, a zdarzenia wymagające uwagi mają pole `alert`:

| `alert` | Kiedy |
|---|---|
| `publish_failed` | publikacja się nie udała (także niejednoznacznie) |
| `post_missed` | post przekroczył próg spóźnienia i nie został opublikowany |
| `linkedin_login_expiring` | do wygaśnięcia logowania LinkedIn zostało 7 dni lub mniej (raz na godzinę) |
| `scheduler_error` | błąd przebiegu harmonogramu |
| `live_mode` | start w trybie live |

Przykładowe zapytanie do reguły alertu (Log Analytics, co 15 min, warunek: liczba wyników > 0, akcja: e-mail):

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "linkedin-mcp"
| extend j = parse_json(Log_s)
| where tostring(j.alert) in ("publish_failed", "post_missed", "linkedin_login_expiring", "scheduler_error")
| project TimeGenerated, alert = tostring(j.alert), msg = tostring(j.msg), postId = tostring(j.postId)
```

## 9. Administracja

Komendy działają z komputera, który ma dostęp do bazy (np. po dodaniu swojego adresu IP w zaporze PostgreSQL), z `DATABASE_URL` w `.env`:

```powershell
npm run cli -- server status                 # właściciel, logowanie LinkedIn, pauza, kolejka
npm run cli -- server pause "powód"          # bezpiecznik: nic nie zostanie opublikowane
npm run cli -- server resume
npm run cli -- server owner-reset --yes      # odłącza właściciela i unieważnia tokeny konektora
```

Dostęp do bazy z własnego komputera:

```powershell
az postgres flexible-server firewall-rule create -g $RG -n $PG --rule-name my-ip --start-ip-address <twoje-IP> --end-ip-address <twoje-IP>
```

Usuń tę regułę po zakończeniu pracy.

## 10. Aktualizacja aplikacji

```powershell
az acr build -r $ACR -t linkedin-mcp:2 .
az containerapp update -g $RG -n $APP --image "$ACR.azurecr.io/linkedin-mcp:2"
```

Przy restarcie post przerwany w trakcie publikacji dostaje `failed` z kodem `publish_interrupted` i nie jest ponawiany. Sprawdź go ręcznie na LinkedIn.

## Test lokalny przed wdrożeniem

`docker compose up --build` uruchamia PostgreSQL i aplikację pod adresem `http://localhost:8080`. Wcześniej utwórz plik `.env.server` (jest w `.gitignore`):

```
LINKEDIN_CLIENT_ID=…
LINKEDIN_CLIENT_SECRET=…
LINKEDIN_MCP_ENC_KEY=…   (32 bajty base64)
```

Claude Desktop nie połączy się z adresem `localhost`, bo konektory są wywoływane z chmury Anthropic. Lokalnie sprawdzisz przepływ w MCP Inspector:

```powershell
npx -y @modelcontextprotocol/inspector
```

W Inspectorze wybierz transport Streamable HTTP i adres `http://localhost:8080/mcp`. Logowanie LinkedIn zadziała po dodaniu w Developer Portal adresu `http://localhost:8080/oauth/callback`.
