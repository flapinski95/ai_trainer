# Web Push

## Konfiguracja

Ustaw w srodowisku serwera:

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`: nieskompresowany klucz publiczny P-256 w base64url.
- `VAPID_PRIVATE_KEY`: odpowiadajacy mu prywatny klucz P-256 w base64url.
- `VAPID_SUBJECT`: kontakt `mailto:adres@domena.pl` lub adres HTTPS.
- `WEB_PUSH_TRIGGER_SECRET`: losowy sekret o dlugosci co najmniej 32 znakow, dostepny tylko dla serwera i wywolujacej Lambdy.

Nie umieszczaj prywatnego klucza ani sekretu wyzwalania w zmiennych `NEXT_PUBLIC_*`.
Istniejace ustawienia AWS/DynamoDB/KMS pozostaja wymagane. Rola aplikacji musi
pozwalac na GetItem, Query, PutItem, UpdateItem, DeleteItem i ConditionCheckItem
oraz Encrypt/Decrypt uzywanym kluczem KMS. Subskrypcje sa szyfrowane z kontekstem
`{ userId, purpose: "WEB_PUSH" }`.

## Subskrypcja

Uzytkownik wlacza przelacznik w `/settings`. Pytanie o zgode jest wywolywane
bezposrednio z gestu uzytkownika. Na iOS wymagane sa HTTPS, iOS 16.4+ oraz
uruchomienie aplikacji z ekranu poczatkowego. Zablokowane uprawnienie trzeba
zmienic w ustawieniach przegladarki/systemu.

- `GET /api/push`: klucz publiczny, wymagane logowanie.
- `POST /api/push`: standardowy obiekt `PushSubscription.toJSON()`, wymagane
  logowanie i zgodny Origin.
- `DELETE /api/push`: `{ "endpoint": "https://..." }`, wymagane logowanie i
  zgodny Origin. Usuniecie dotyczy tylko aktualnego urzadzenia/uzytkownika.

## Wyzwalanie Po Treningu

Dedykowana Lambda `backend/push/handler.ts` konsumuje zadania
`PUSH_WORKOUT_JOB` z DynamoDB Streams i wywoluje:

```http
POST /api/push/workout
Authorization: Bearer <WEB_PUSH_TRIGGER_SECRET>
Content-Type: application/json

{"userId":"<application-user-id>","provider":"strava","activityId":"123456"}
```

`provider` moze byc tez `garmin`. Endpoint sprawdza priorytet Stravy oraz
obecnosc aktywnego treningu ze zrodla `WEBHOOK`; pomija importy i historie.
Zadanie powstaje atomowo razem z pierwszym zapisem treningu. Strava wymaga
zdarzenia `create`; Garmin dopuszcza `activities` oraz `activityDetails`,
niezaleznie od ich kolejnosci. Edycje, usuniecia, historia i importy nie
tworza nowych zadan. Przetwarzanie nie blokuje workerow treningowych.
Nieudane wywolania sa ponawiane przez Streams maksymalnie 10 razy,
nie dluzej niz przez 24 godziny. Bledy 4xx zwykle wymagaja poprawienia
konfiguracji; nie zostaja oznaczone jako sukces. Po wyczerpaniu ponowien
metadane trafiaja do szyfrowanej kolejki bledow, a zadanie pozostaje w tabeli.

Jedna trwala sesja odprawy przypada na trening. Ponowienia korzystaja z tej
samej sesji i pomijaja subskrypcje z zapisanym potwierdzeniem dostarczenia.
Rownolegle wywolania lub awaria miedzy dostarczeniem a zapisem potwierdzenia
moga ponowic Push; identyczny tag scala widoczne powiadomienia. Odpowiedzi
404/410 usuwaja wygasla subskrypcje. Klikniecie otwiera
`/chat?sessionId=<uuid>` z kontrola dostepu przez sesje uzytkownika.

## Wdrozenie Lambdy

1. Udostepnij aplikacje przez publiczny HTTPS. Lambda w AWS nie moze
  polaczyc sie z `localhost:3000`; podczas pracy lokalnej potrzebny jest
  tunel HTTPS. Endpoint musi korzystac z tej samej tabeli i konfiguracji
  aplikacji co uzytkownik zapisujacy subskrypcje.
2. Przygotuj bundle nowej Lambdy (`npm run build:push`) i zaktualizowane
  bundle workerow (`npm run build:worker`, `npm run build:garmin`).
  Te polecenia sa wymagane przy wdrozeniu; samo dodanie kodu nie zmienia AWS.
3. Ustaw w konfiguracji Terraform ponizsze wartosci i wdroz zasoby
  po przejrzeniu planu:

```hcl
enable_web_push             = true
web_push_processing_enabled = false
web_push_endpoint           = "https://twoja-domena.pl/api/push/workout"
```

4. W AWS Secrets Manager wypelnij sekret wskazany przez output
  `web_push_secret_arn` ponizszym JSON-em. Wartosc musi byc identyczna
  z `WEB_PUSH_TRIGGER_SECRET` aplikacji. Nie zapisuj jej w Terraform.

```json
{"web_push_trigger_secret":"<ta-sama-wartosc-co-WEB_PUSH_TRIGGER_SECRET>"}
```

5. Wlacz `web_push_processing_enabled = true` i wdroz zmiane. Aktualizuje
  ona zarowno mape Streams, jak i `WEB_PUSH_ENABLED` workerow treningowych.
  Musi byc tez wlaczone przetwarzanie odpowiedniego dostawcy:
  `strava_worker_processing_enabled` lub `garmin_processing_enabled`.
  Subskrypcja Push musi byc zapisana na urzadzeniu odbiorcy.
6. Przetestuj nowy trening z webhooka. Istniejace treningi nie sa wysylane
  wstecz. Poprawnie obsluzone zadanie otrzymuje stan `COMPLETED`, liczbe
  `sent` i `completedAt`. `sent: 0` moze oznaczac brak subskrypcji,
  priorytet innego dostawcy lub pominiecie treningu przez endpoint.

Outputy `push_worker_function_name` i `push_worker_failure_queue_url`
wskazuja funkcje oraz kolejke diagnostyczna. Kolejka przechowuje metadane
awarii, nie pelny trening: odzyskiwanie wymaga odczytu pozostawionego zadania.
Trwale bledy sa logowane jako `push_worker_job_failed` bez sekretow i tresci
odpowiedzi HTTP. Po naprawie mozna ponowic wywolanie endpointu dla tego
samego treningu; potwierdzenia dostarczenia ograniczaja duplikaty.

## Service Worker

Zrodlo TypeScript jest w `app/sw.ts`; route `app/sw.js/route.ts` serwuje je
jako samodzielny JavaScript pod `/sw.js` z zakresem `/`.
Strategia NetworkFirst dla nawigacji/API nie zapisuje prywatnych odpowiedzi.
Cache obejmuje tylko publiczna strone offline. Worker nie prosi o zgode na
powiadomienia przy uruchamianiu aplikacji.

## Weryfikacja

Sprawdz diagnostyke TypeScript oraz w przegladarce: aktywacje workera,
manifest, ikony, zgode na Push, zapis subskrypcji, wywolanie po nowym treningu,
klikniecie powiadomienia i ponowienie tego samego zdarzenia.
Wysylka wymaga rzeczywistych kluczy VAPID i zgody przegladarki.