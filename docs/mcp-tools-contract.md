# Kontrakt narzędzi serwera MCP LinkedIn

Ten dokument jest jednocześnie instrukcją dla skilla (jak wywoływać narzędzia) i specyfikacją dla osoby lub narzędzia budującego serwer (co serwer musi zapewnić). Nazwy narzędzi i pola są częścią kontraktu. Jeśli serwer je zmienia, zaktualizuj ten plik.

## Zasady projektowe

- Serwer publikuje na LinkedIn wyłącznie przez oficjalne API, z profilu osobistego zalogowanego użytkownika.
- Nie ma narzędzia do natychmiastowej publikacji. Każdy post ma termin co najmniej 5 minut w przyszłości względem chwili zatwierdzenia.
- Zapis do kolejki następuje w dwóch krokach: **podgląd**, a potem **zatwierdzenie na podstawie identyfikatora planu**. Zatwierdzenie zapisuje dokładnie te treści, które zostały pokazane w podglądzie.
- Logowanie do LinkedIn (OAuth) odbywa się na stronie serwera w przeglądarce, nigdy przez narzędzia MCP. Tokeny nie są zwracane przez żadne narzędzie.
- Wszystkie narzędzia zwracają błędy w postaci czytelnego opisu i kodu, bez ujawniania sekretów.
- Serwer zapisuje log każdej operacji (kto, co, kiedy, wynik).

## Format czasu

Terminy w danych wejściowych: tekst w formacie ISO 8601 bez strefy, np. `2026-11-06T08:00:00`, interpretowany w strefie podanej w polu `timezone` (domyślnie `Europe/Warsaw`, z uwzględnieniem zmiany czasu). W odpowiedziach serwer zwraca zarówno czas lokalny, jak i UTC.

## Narzędzia

### `linkedin_auth_status`

Sprawdza połączenie z LinkedIn. Bez parametrów.

Zwraca: `connected` (tak lub nie), `profile_name`, `profile_url`, `expires_at`, `days_left`, `login_url` (adres strony logowania na serwerze), `can_post` (tak lub nie), `can_comment` (tak, nie lub nieznane).

Kodowanie w JSON: `connected` i `can_post` to wartości logiczne (`true`/`false`), a `can_comment` przyjmuje `"yes"`, `"no"` lub `"unknown"`. Do pierwszej próby dodania komentarza ma wartość `"unknown"`, potem zależy od wyniku tej próby. `expires_at` jest w UTC (ISO 8601), a `days_left` to liczba całkowitych dni do wygaśnięcia.

### `linkedin_preview_series`

Waliduje serię i zwraca podgląd. **Niczego nie zapisuje do kolejki.**

Parametry:
- `timezone` (opcjonalnie, domyślnie `Europe/Warsaw`)
- `posts` (lista), a w każdym elemencie:
  - `text` - treść posta, dokładnie taka, jaka ma się ukazać
  - `publish_at` - termin publikacji (czas lokalny)
  - `comment_text` - komentarz (może być pusty, wtedy brak komentarza)
  - `link_mode` - `none` (komentarz bez linku) lub `later` (w komentarzu jest symbol `[LINK]`, link poda użytkownik)
  - `comment_text_no_link` - zatwierdzona wersja komentarza bez linku, używana gdy link nie zostanie podany na czas
  - `if_no_link` - `post_without_link` lub `skip`
  - `comment_delay_min` - opóźnienie komentarza w minutach (domyślnie 10)
  - `image_path` - opcjonalnie: pełna ścieżka do pliku obrazu (JPG, PNG lub GIF) na dysku użytkownika; jeden obraz na post
  - `image_alt` - opcjonalnie: tekst alternatywny obrazu

Zwraca: `plan_id`, `expires_in_min` (ważność planu), `posts` (dla każdego: numer, `publish_at_local`, `publish_at_utc`, liczba znaków, `warnings`, `errors`) oraz podsumowanie.

Walidacje po stronie serwera: termin co najmniej 5 minut w przyszłości, długość posta (limit około 3000 znaków), duplikat treści względem kolejki i opublikowanych postów, kolizje terminów, symbol `[LINK]` wymaga `link_mode` równego `later`, `later` wymaga wersji `comment_text_no_link` lub `if_no_link` równego `skip`.

Kolizja terminów to dwa posty, które trafią do tego samego przebiegu harmonogramu (patrz „Harmonogram”). Serwer zwraca ją jako **ostrzeżenie** w `warnings`, a nie jako błąd. Posty z tego samego przebiegu wychodzą po kolei, w kolejności terminów. Ostrzeżenie dostaje też termin, który nie wypada na pełnym przebiegu, i wtedy podaje faktyczną godzinę publikacji.

Serwer sam zamienia treść na format wymagany przez LinkedIn, w tym poprawnie zapisuje znaki specjalne, i nie zmienia sensu treści.

### `linkedin_commit_series`

Zatwierdza serię z podglądu.

Parametry: `plan_id`.

Zwraca: `series_id` oraz listę postów z `id`, `status`, `publish_at_local`.

Wymaga ważnego `plan_id`. Jeśli plan wygasł lub został już zatwierdzony, zwraca błąd. Zatwierdzenie tego samego planu drugi raz nie tworzy duplikatów.

### `linkedin_list_queue`

Pokazuje kolejkę.

Parametry (wszystkie opcjonalne): `status`, `series_id`, `from`, `to`.

Zwraca listę postów: `id`, `series_id`, początek treści, `publish_at_local`, `status`, `comment_status`, `post_url` (po publikacji), `last_error`.

### `linkedin_get_post`

Parametry: `id`. Zwraca pełne dane jednego posta wraz z historią zdarzeń.

### `linkedin_update_post`

Zmienia treść, termin lub komentarz posta **przed publikacją**.

Parametry: `id` oraz pola do zmiany (`text`, `publish_at`, `comment_text`, `comment_text_no_link`, `if_no_link`, `image_path`, `image_alt`, `remove_image`). Zwraca zaktualizowany post. Odrzuca zmianę, jeśli post ma już status inny niż `scheduled` lub `missed`, albo termin jest bliższy niż 5 minut.

Post ze statusem `missed` można przywrócić do harmonogramu, podając nowy `publish_at` (co najmniej 5 minut w przyszłości). Po takiej zmianie wraca do statusu `scheduled`. Zmiana samej treści posta `missed` bez nowego terminu jest odrzucana.

### `linkedin_cancel_post`

Parametry: `id`. Anuluje zaplanowany post (i jego komentarz). Działa dla statusów `scheduled`, `missed` i `failed`. Odrzuca, jeśli post jest już publikowany lub opublikowany.

### `linkedin_set_comment_link`

Uzupełnia link w komentarzu z trybem `later`.

Parametry: `id`, `url` (adres http lub https). Serwer podstawia adres w miejsce `[LINK]`. Odrzuca adres niebędący poprawnym URL-em.

## Szczegóły implementacji (serwer lokalny)

- `linkedin_preview_series` zwraca dla każdego posta dodatkowo `publish_effective_local`, czyli faktyczną godzinę przebiegu, oraz `comment` (długość, `link_mode`, `if_no_link`, opóźnienie). Jeśli seria ma błędy, zwraca `plan_id: null` i niczego nie zapisuje. Komentarz ma limit 1250 znaków. Gdy przy `link_mode: later` podano tylko `comment_text_no_link`, `if_no_link` przyjmuje domyślnie wartość `post_without_link`.
- `linkedin_commit_series` przy zatwierdzeniu sprawdza jeszcze raz minimalne wyprzedzenie terminu i duplikaty, bo od podglądu mogło minąć do 30 minut. Jeśli któryś warunek nie jest spełniony, zwraca błąd `plan_no_longer_valid`.
- `linkedin_list_queue`: `from` i `to` to czas lokalny w strefie domyślnej, w formacie `RRRR-MM-DD` (cały dzień) lub `RRRR-MM-DDTGG:MM[:SS]`.
- `linkedin_auth_status` zwraca dodatkowo `mode` (`mock`/`live`), `paused` i `warnings`. Ostrzeżenia dotyczą wygasania logowania (7 dni lub mniej), pauzy, braku połączenia i postów z błędem publikacji.
- `linkedin_set_comment_link` działa, dopóki komentarz nie został wysłany. Link można też zmienić po publikacji posta, jeszcze przed dodaniem komentarza.

### Obrazy

- Post może mieć jeden obraz. `image_path` to pełna ścieżka do pliku na dysku użytkownika; może być w cudzysłowie, jak przy kopiowaniu z Eksploratora. Obrazu wklejonego do czatu nie da się przekazać, trzeba podać ścieżkę do pliku.
- Format serwer rozpoznaje po nagłówku pliku, a nie po rozszerzeniu. Dozwolone formaty to JPG, PNG i GIF, a limit rozmiaru ustawia `IMAGE_MAX_MB` (domyślnie 10 MB). Limity LinkedIn (rozmiar, rozdzielczość, długość tekstu alternatywnego) zostaną sprawdzone w dokumentacji Images API w etapie 5.
- Przy podglądzie serwer kopiuje plik do katalogu danych (`images/<sha256>.<rozszerzenie>`). Zatwierdzenie i publikacja używają tej kopii, więc późniejsza zmiana lub usunięcie oryginału nie zmienia zatwierdzonej treści. Jeśli kopia zniknie albo się zmieni, post dostaje `failed` z kodem `image_missing` i nie jest wysyłany.
- Podgląd i dane posta zawierają `image`: `file_name`, `mime`, `bytes`, `width`, `height`, `alt`. Brak `image_alt` daje ostrzeżenie. Podsumowanie podglądu ma pole `with_image`.
- Obraz jest wysyłany do LinkedIn przed utworzeniem posta. Błąd wysyłania jest więc jednoznaczny: post nie powstaje, a serwer niczego nie ponawia.
- `linkedin_update_post`: `image_path` dodaje albo podmienia obraz, `image_alt` zmienia opis istniejącego obrazu, a `remove_image: true` usuwa obraz. `image_path` i `remove_image` razem to błąd.

### Kody błędów

Błąd narzędzia ma postać `{ "error": { "code", "message", "details"? } }`, a `isError` jest ustawione na `true`.

`invalid_arguments`, `invalid_timezone`, `invalid_datetime`, `nonexistent_local_time`, `plan_not_found`, `plan_expired`, `plan_already_committed` (w `details` jest `series_id`), `plan_no_longer_valid`, `post_not_found`, `not_editable`, `nothing_to_update`, `too_close_to_publish`, `missed_requires_new_time`, `validation_failed` (w `details` są `errors` i `warnings`), `not_cancelable`, `invalid_url`, `not_link_later`, `comment_not_pending`, `conflict`, `internal_error`.

Błędy nakładki stdio: `worker_not_running` (komunikat zawiera komendę uruchomienia workera), `worker_timeout`, `worker_auth_failed`, `worker_bad_response`, `config_error`.

Kody w `last_error` i `comment_error`: `linkedin_rejected`, `linkedin_unauthorized`, `linkedin_forbidden`, `linkedin_rate_limited`, `linkedin_network`, `linkedin_timeout`, `linkedin_ambiguous`, `publish_interrupted`, `comment_interrupted`, `comment_missed`, `post_not_published`, `image_missing`, `internal_error`. Pole `ambiguous: true` oznacza, że nie wiadomo, czy obiekt powstał na LinkedIn.

## Harmonogram

- Przebieg harmonogramu działa co `SCHEDULER_INTERVAL_MIN` minut (domyślnie 5) i jest wyrównany do zegara (:00, :05, :10…). Pierwszy przebieg rusza od razu po starcie serwera.
- Post wychodzi w pierwszym przebiegu o godzinie równej terminowi lub późniejszej. Termin 08:00 oznacza publikację o 08:00, a termin 08:02 publikację o 08:05. Tak samo wyrównywany jest termin komentarza (publikacja + `comment_delay_min`).
- Zmiana czasu: godzina podwójna jesienią (np. 02:30 w dniu przejścia na czas zimowy) oznacza jej pierwsze wystąpienie, czyli czas letni, i daje ostrzeżenie. Godzina nieistniejąca wiosną (np. 02:30 w dniu przejścia na czas letni) daje błąd `nonexistent_local_time`.
- Po błędzie niejednoznacznym, czyli timeoucie po wysłaniu, zerwanym połączeniu albo przerwaniu przez restart, serwer niczego nie ponawia automatycznie. Nie ponawia też po błędzie jednoznacznym: post dostaje status `failed`, a ponowienie wymaga decyzji użytkownika.
- Komentarz, którego termin minął o co najmniej `MISSED_GRACE_MIN` minut (serwer nie działał), jest pomijany: status komentarza `skipped`, kod `comment_missed`.
- Przy bezpieczniku `PAUSE` harmonogram nie publikuje postów ani komentarzy. Polityka `missed` nadal działa.

## Statusy posta

- `scheduled` - zatwierdzony, czeka na termin
- `publishing` - trwa publikacja
- `published` - opublikowany
- `failed` - publikacja się nie udała (szczegóły w `last_error`), serwer nie ponawia automatycznie po błędzie niejednoznacznym, żeby nie zdublować posta
- `canceled` - anulowany
- `missed` - termin minął, gdy serwer nie działał (np. wyłączony komputer), a spóźnienie przekroczyło próg `MISSED_GRACE_MIN` (domyślnie 60 minut). Serwer takiego posta **nie publikuje**. Post jest widoczny w kolejce. Można mu nadać nowy termin przez `linkedin_update_post` albo go anulować. Posty spóźnione mniej niż o próg są publikowane od razu po starcie serwera.

## Statusy komentarza

- `none` - brak komentarza
- `waiting` - czeka na termin po publikacji
- `waiting_link` - czeka na link (tryb `later`)
- `done` - dodany
- `skipped` - pominięty (zgodnie z `if_no_link`, brak uprawnień, post nieopublikowany albo termin komentarza minął, gdy serwer nie działał)
- `failed` - nie udało się dodać

## Wymagania niefunkcjonalne dla serwera

- Publiczny adres HTTPS i transport strumieniowy HTTP (Streamable HTTP).
- Uwierzytelnianie punktu końcowego MCP (nie zostawiaj go otwartego w produkcji) oraz ograniczenie liczby wywołań.
- Harmonogram odporny na restart: stan w bazie, blokada wiersza przy publikacji, jedna publikacja na wiersz (idempotentnie).
- Alert przed wygaśnięciem logowania LinkedIn (około 60 dni) i po błędzie publikacji.
- Przechowywanie tokenów i sekretów w bezpiecznym magazynie (np. Key Vault), nigdy w kodzie ani w repozytorium.