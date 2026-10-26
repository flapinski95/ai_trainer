# AI Endurance Coach (PWA)

An AI-powered private Progressive Web App (PWA) built for runners and cyclists to analyze endurance training and daily recovery metrics.

## Key Features
- **Garmin & Strava Integration:** Automatic Webhook sync for activities, sleep scores, Body Battery, and HRV Status.
- **Proactive AI Coaching:** Natural language feedback powered by LLMs (Gemini / Claude / OpenAI) with custom heart rate and power zone awareness.
- **Bring Your Own Key (BYOK):** Users provide their own API keys for complete control over privacy and AI models.
- **Multi-Sport Support:** Separate chat contexts and history for cycling and running.

## Tech Stack
- **Frontend:** Next.js (App Router), Tailwind CSS, PWA (Web Push Notifications)
- **Backend:** AWS Serverless (API Gateway, AWS Lambda, DynamoDB Single-Table Design)
- **Infrastructure:** Terraform
- **Integrations:** Garmin Connect API, Strava API v3, Vercel AI SDK

## Architecture Overview
1. **Webhook Processing:** Garmin/Strava push activity and health events to AWS API Gateway.
2. **Data Aggregation:** AWS Lambda formats the metrics and updates user records in DynamoDB.
3. **AI Router:** Formats the prompt with athlete baseline metrics (HRV, Z2-Z5 zones, training load) and streams the response to the Next.js frontend.

## Web App And Strava Login

The Next.js App Router frontend uses Auth.js v5 (currently a beta release) with independent
Strava and Garmin OAuth providers. Signing in through either creates an internal user and connects the athlete
in one operation; there is no separate password registration. OAuth `state`, CSRF
protection, and encrypted HTTP-only session cookies are managed by Auth.js. The
provider requests `read,activity:read`; refusing activity permission prevents login.
Private "Only You" activities require the separate `activity:read_all` scope, not
requested by default. There is no password flow or development authentication bypass.

Configure a git-ignored `.env.local` at the repository root using the fields in
[.env.example](.env.example):

| Variable | Local value |
| --- | --- |
| `AUTH_URL` | `http://localhost:3000` |
| `AUTH_SECRET` | A persistent random secret of at least 32 characters, generated locally with `openssl rand -base64 32` |
| `AUTH_STRAVA_ID` | Strava Client ID (`290868` for the current application) |
| `AUTH_STRAVA_SECRET` | Strava Client Secret, not an access token or webhook verify token |
| `AUTH_GARMIN_ID` | Garmin app Client ID; independent of Strava |
| `AUTH_GARMIN_SECRET` | Garmin app Client Secret; never use a personal Garmin password |
| `AWS_PROFILE` | `personal` for local development only |
| `AWS_REGION` | `eu-north-1` |
| `DYNAMODB_TABLE_NAME` | `ai-trainer-dev-app` |
| `DYNAMODB_KMS_KEY_ARN` | The value of `terraform -chdir=infra/terraform output -raw dynamodb_kms_key_arn` |

Never prefix secrets with `NEXT_PUBLIC_`, commit `.env.local`, or paste credentials
into chat. The app remains visible but disables login until configuration is complete.
Local AWS credentials use the SDK credential chain; do not put access keys in source.

In the Strava application's settings, set **Authorization Callback Domain** to
`localhost`. The OAuth callback is `http://localhost:3000/api/auth/callback/strava`.
It is not the API Gateway `/webhooks/strava` endpoint. Strava documents localhost
and 127.0.0.1 as whitelisted callback hosts. Open the app on the exact host and port
configured in `AUTH_URL`, and set `AUTH_URL` to the real HTTPS origin in production.

```bash
npm ci
npm run dev
```

For checks and separate deployment artifacts:

```bash
npm test
npm run typecheck
npm run build:web
npm run build
```

`build:web` compiles Next.js; `build` bundles both webhook and worker Lambdas.
Use `npm start` for the built web application. No frontend hosting is provisioned by
Terraform yet. The Next.js server requires `dynamodb:GetItem`, `dynamodb:BatchGetItem`,
`dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, `dynamodb:ConditionCheckItem`, and
`dynamodb:Query` on the app table and `GSI1`, plus `kms:Encrypt` and `kms:Decrypt`
and `kms:GenerateDataKey` on its KMS key
(and the DynamoDB SSE permissions needed by that execution identity). For production,
use a dedicated execution role with scoped permissions, not the personal administrator
profile. Keep production secrets in the hosting platform's secret storage.

Logged-in users can save OpenAI, Anthropic, and Google Gemini API keys from the
**Klucze AI** section of the dashboard. Keys are encrypted with the DynamoDB KMS key
using the internal user ID and provider as encryption context; settings only display
whether a key exists. Chat sessions and ordered messages use `CHAT#<sessionId>` and
`MSG#<sessionId>#<timestamp>#<messageId>` sort keys. Message writes update the session
count and timestamp in the same DynamoDB transaction.

The **Trener AI** panel streams replies using the selected provider's saved key. The
key is decrypted only on the server and is never sent to the browser. Each request
includes the last six messages, up to five recent workouts from the selected activity
source, lifetime training totals, and the latest Garmin daily metrics when Health
Export permission is active. Provider failures return a generic message without
exposing upstream error details.

The model picker offers current text models: GPT-6 Astra, GPT-6.1 Sol, and GPT-6 Luna;
Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, and Fable 5.1; Gemini 4 Argon, 3.8 Flash,
3.6 Flash, and 3.5 Flash-Lite. The API accepts only model IDs in the corresponding
provider catalog. Catalogs should be reviewed against the providers' [OpenAI model
list](https://developers.openai.com/api/docs/models), [Anthropic model
overview](https://platform.claude.com/docs/en/docs/about-claude/models/overview), and
[Gemini API model list](https://ai.google.dev/gemini-api/docs/models) as providers
change availability.

After a successful callback, KMS encrypts the access/refresh-token pair using the
internal user ID and provider as encryption context. A DynamoDB transaction updates
`USER#strava-<athleteId>/PROFILE` and `CONNECTION#STRAVA`, with `GSI1PK = STRAVA#<athleteId>`.
KMS or database failure prevents session creation. No OAuth credentials are placed in
the session cookie, client JavaScript, or account-summary response. The account view
reads only connection metadata using a DynamoDB projection.

Verify real authorization by signing in, granting activity permission, and checking
the connected athlete ID and name. DynamoDB should contain a connection with
`encryptedTokens`, not plaintext tokens. Signing out clears the application session;
it does not revoke Strava access. Revocation is available in Strava's connected-app
settings. The optional stream worker described below refreshes tokens and processes
new activity events. The dashboard reads the latest 50 active workouts through GSI1,
then projects metrics from the base table; it never fetches or decrypts Strava tokens.
Use its refresh icon to reload after an event has been processed. Disconnected
accounts do not display stored workouts. Automatic historical import is described below.

## Garmin Connect

Garmin is independent of Strava: its Client ID/Secret can be configured without any
Strava credentials. Add `AUTH_GARMIN_ID` and `AUTH_GARMIN_SECRET` to your local web
configuration, keeping the existing `AUTH_SECRET` and AWS settings unchanged. Register
`${AUTH_URL}/api/auth/callback/garmin` in your Garmin app. Production requires HTTPS;
if Garmin's portal does not accept your local callback, use an HTTPS development
origin registered in that portal and set `AUTH_URL` to that exact origin.

The verified OAuth2 PKCE endpoints are Garmin Connect `oauth2Confirm`, the DIAUTH
token endpoint, and Partner Gateway `/rest/user/id` and `/rest/user/permissions`.
Auth.js performs PKCE S256 and `state` validation; code/token exchange and user identity
requests run server-side. OAuth's generic scopes do not imply consent: actual
`ACTIVITY_EXPORT`, `HEALTH_EXPORT`, `MCT_EXPORT`, `WORKOUT_IMPORT` and `COURSE_IMPORT`
permissions are fetched from Garmin. The app never requests a Garmin password.

Provider identities map to an independent application ID. Existing `strava-<athleteId>`
users retain their IDs and data; new users receive UUIDs. While logged in, use **Polacz
Garmin** or **Polacz Strave** to attach the second provider. Accounts already linked
to another user are rejected, not automatically merged. A different account of the
same provider cannot replace the existing connection implicitly. There is no automatic
merge by name or email and no destructive migration of existing users.

### Source Rules

| Active connections | Diary and workout totals | Health source |
| --- | --- | --- |
| Garmin only | Garmin | Garmin |
| Strava only | Strava | None from Garmin |
| Both | Strava | Garmin |

Provider-specific workout records and aggregates are retained separately. The diary
and context read only the selected provider, so Garmin and Strava copies are not added
together. Revoking Strava falls back to Garmin's received data; a Garmin disconnection
does not block a connected Strava account. Missing Strava activities are not filled
with Garmin ones while Strava is active. This is source selection, not probabilistic
cross-provider activity matching. Garmin workout duration is displayed as elapsed
training time, not claimed to be measured moving time.

### Manual Garmin History Import

In **Profil / Ustawienia**, upload a Garmin Connect GDPR `.zip`, a `.fit` activity,
or a health `.csv` / `.json`. The parser reads original activities under
`DI_CONNECT/DI-Connect-Uploaded-Files` and health records under
`DI_CONNECT/DI-Connect-User` (also `DI-Connect-Wellness`). Nested ZIP archives retain
their parent directory context and are supported up to four
archive levels. The authenticated, same-origin `POST /api/garmin/import` endpoint
accepts at most 25 MB uploaded, 100 MB expanded, 1,000 archive entries and 1,000
workouts, with at most 10 MB per FIT file. Hosting request-size and execution-time
limits must also permit the upload; the route allows up to 300 seconds.

The official Garmin FIT SDK validates file integrity and first decodes lightweight
session summaries. Workouts starting within the last **90 days** are eligible for
detailed import, using the same inclusive time boundary as Strava history sync.
There is no workout count limit within this window. Eligible FIT sessions retain decoded
records, laps, zones and all other messages plus the original FIT bytes. Telemetry
is encrypted with KMS and split into versioned segments under
`TELEMETRY#GARMIN#<activityId>`; `TELEMETRY_INDEX#GARMIN#<activityId>` indexes the cache.
Telemetry outside the 90-day window is evicted during import, while lightweight per-workout metrics
(distance, time, average speed/power and elevation) and `SUMMARY#GARMIN#...` aggregates
remain. Each decoded detailed payload is limited to 64 MB. A per-user import lease
serializes cache maintenance. Older separate imports cannot displace newer details.

An archive workout is skipped if its normalized UTC start timestamp already belongs
to Strava or Garmin PUSH, even if its sport or provider ID differs. The common writer
also records `WORKOUT_TIMESTAMP#<timestamp>` protection atomically for new Strava and
Garmin PUSH writes. Re-imported manual sessions reuse their IDs and do not increment
totals. A per-user start-time/sport identity links accepted FIT sessions to later
Garmin updates; provider aliases preserve deletion handling. If an import stops after partial writes,
upload the same archive again to finish. A successful import opens a refreshed diary.
Manual import requires an application session but not Garmin OAuth. Strava retains
priority when connected, so the diary never combines duplicate provider histories.

The recovery panel reads `USER#<userId>` / `METRIC#<date>` manifests and decrypts
their existing KMS-encrypted artifacts. Latest-date selection uses a strongly
consistent table query, excluding encrypted chunks and following pagination, rather
than waiting for GSI propagation. While visible, the panel refreshes every five
seconds and immediately on focus; it stops polling when hidden or unmounted.
Missing data links to the import form; transient failures preserve the last values.
Daily HRV, Body Battery, sleep score/duration and resting heart rate are read from
nested JSON or BOM/quoted CSV with comma, semicolon or tab delimiters. Health-only
archives are valid. Invalid measurements are omitted rather than fabricated, and
files without recognized health fields are reported in the skipped-file count.
Imports merge into the same KMS-encrypted `METRIC#<date>` records; PUSH sources always
take precedence over archived values. Without Health permission, the API exposes only
the imported source values, never merged PUSH values. Activity FIT files alone still
do not supply daily recovery history. Garmin exports vary by product/version; unknown
field layouts need an anonymized sample before adding a verified mapping.

The Garmin import and Strava history processor share the same 90-day time-window
predicate. Strava uses it when fetching missing summary fields; Garmin uses it for
retaining FIT telemetry. Strava does not currently persist full telemetry streams.

### Garmin PUSH Deployment

The supplied Start Guide 2.0 documents Starter Access as push-only with no historical
data. The provided OAuth2 PKCE, Health API 2.0 and Activity API 2.0 specifications were
used for protocol/field mapping; proprietary source PDFs are not committed here.
No undocumented pull/history endpoint is called. Enterprise history is a separate
capability and is not enabled by listing the five API products.

Build Lambda artifacts with `npm run build`, then set local Terraform values:

```hcl
enable_garmin_integration = true
garmin_processing_enabled = false
```

Generate a separate random URL-safe callback token locally (`openssl rand -hex 32`)
and provide it as sensitive `garmin_webhook_token` (for example through
`TF_VAR_garmin_webhook_token`). Do not reuse the Strava verify token. Preserve existing
Strava settings if that integration is deployed. Review plan/apply yourself. A Garmin-only
deployment needs no Strava ARN, token or subscription. The table and KMS key are shared;
resources are opt-in, with in-place state moves for previously uncounted Strava routes.

Populate the created Secrets Manager secret named by output `garmin_oauth_secret_arn`
outside Terraform with the Garmin app's `client_id` and `client_secret`. No secret
version is managed by Terraform. Then set `garmin_processing_enabled = true`, review
the new plan and apply it yourself. The worker has 30-second timeout, bounded log
retention, one reserved execution and an encrypted failure-metadata queue. Available
Lambda concurrency quota is required. No Strava Lambda is needed by this pipeline.

Retrieve the secret-bearing base URL locally with:

```bash
terraform -chdir=infra/terraform output -raw garmin_push_base_url
```

In `https://apis.garmin.com/tools/endpoints`, configure each applicable summary to the
base URL plus the appropriate suffix, preserving the whole secret path:

| Summaries | Suffix |
| --- | --- |
| activities, manuallyUpdatedActivities, activityDetails, activityFiles, moveIQActivities | `/activity` |
| Every enabled Health summary | `/health` |
| Every approved Women's Health summary | `/womens-health` |
| userPermissionsChange | `/permissions` |
| deregistrations | `/deregistration` |

This is an application-managed bearer secret in the URL, not a claimed Garmin HMAC
signature. The provided docs do not define a signature/header verification contract.
Never expose these URLs in UI, logs, public tickets or screenshots; URL possession
authorizes delivery. API Gateway access logging is not enabled by this module. Any
added proxy/WAF/access logging must redact the secret path. The receiver additionally
matches Garmin IDs to authenticated app connections and verifies current permissions.
New domains can require Garmin's security review (the Start Guide mentions 24–48h).
Use Garmin's On Hold setting while configuring/testing endpoints to avoid losing data.

### Complete Health Preservation

The ingress accepts the documented JSON lists with per-record `userId`. It persists
before returning 200, and returns a non-success response on invalid/oversized input or
failed storage so Garmin can retry. No health payload, token or callback URL is logged.
Requests are limited to 2 MiB decoded JSON; larger notifications are rejected, never
silently truncated. Validate actual notification sizes in Garmin's integration tools
before enabling high-resolution feeds.

All nested JSON fields of accepted Health/Women's Health records are retained, not
restricted to sleep/HRV/Body Battery or a hard-coded medical whitelist. Documented
Health categories include dailies, epochs, sleeps, bodyComps, stressDetails, userMetrics,
pulseox, allDayRespiration, healthSnapshot, hrv, bloodPressures, skinTemp, nutrition,
hydration and breathingVariations. Additional fields and summary-list names are
preserved. Women's Health is accepted through its own category and requires current
`MCT_EXPORT`; `HEALTH_EXPORT` alone does not grant it. Exact Women's Health fields are
kept opaque rather than guessed or clinically interpreted.

Full JSON is gzip-compressed and protected by AES-256-GCM with per-payload KMS data
keys and authenticated encryption context. Encrypted payloads are split into bounded
DynamoDB chunks and committed with their manifest in one transaction. No S3 or
medical-data queue is added. Consent is checked again in the health-write transaction.
OAuth credentials remain KMS-encrypted; refresh rotation is conditional on the prior
token generation. Current ID/permissions are verified with Garmin before processing.

Health records are version-checked by receipt time and replaced atomically using the
same type/summary identity; all fields of the latest accepted record are retained.
Duplicate content skips rewriting. Health data and workout records have no expiry;
the temporary encrypted PUSH inbox expires after seven days, including failed payloads.
The stream retries for up to 24 hours, then failure metadata goes to SQS for operator
recovery before the encrypted inbox expires. SQS is not an automatic replay consumer.
Monitor failures; this retention is not an unlimited delivery guarantee.

Garmin Activity summaries/details map documented metrics to the existing workout
model and separate Garmin aggregates. Complete Activity JSON is also encrypted,
including delivered samples, but no FIT/GPX/TCX file is downloaded: Activity Files
notifications are retained as metadata and their callback URLs are not followed.
Move IQ is retained separately, not counted as an intentionally recorded workout.
Training/Courses permissions are recorded but plan/course publishing is not implemented;
those write APIs are not additional health telemetry streams. The dashboard currently
shows connection/consent and workouts, not a complete medical-record viewer.

Use the scope in Garmin's consent screen and connect only accounts whose data you
want processed. In-app logout only ends the app session; revoke consent in Garmin
Connect settings. No in-app Garmin disconnect/delete-account action is exposed yet;
adding one must call the documented DELETE `/partner-gateway/rest/user/registration`
before marking disconnection complete. Never represent logout as deauthorization.

Tests use synthetic payloads and mocked HTTP/AWS clients. Real OAuth, portal domain
review and PUSH delivery must be verified after secrets and resources are configured.
No production Garmin authorization or infrastructure apply is performed by tests.

## Strava Webhook

The backend supports subscription verification and durable event receipt.
`GET /webhooks/strava` returns the JSON `hub.challenge` for valid subscription requests.
`POST /webhooks/strava` validates and stores activity create/update/delete and athlete
deauthorization events in DynamoDB. It returns 200 only after a successful conditional
write or a duplicate. Storage failures return 503 so Strava can retry. Requests must
contain JSON of at most 16 KiB and the configured subscription ID. Invalid requests
return 400, unexpected subscriptions return 403, and other content types return 415.
Ingestion remains unavailable (503) until `strava_subscription_id` is configured;
GET verification works independently. Other HTTP methods return 405 in the handler.

Requirements: Node.js 22+, Terraform 1.7+ for mock tests, and authenticated AWS access.

From the repository root:

```bash
npm ci
npm test
npm run typecheck
npm run build
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform test
```

Deployment is disabled by default. Set `enable_strava_webhook = true` in your local
Terraform variables file, or export `TF_VAR_enable_strava_webhook=true`. Provide a
random verification token of at least 32 characters, for example generated locally
with `openssl rand -hex 32`. In zsh, enter it without echoing or saving it in shell history:

```bash
read -rs 'TF_VAR_strava_verify_token?Strava verification token: '
export TF_VAR_strava_verify_token
export TF_VAR_enable_strava_webhook=true
terraform -chdir=infra/terraform plan -input=false
```

Review the plan, then run `terraform -chdir=infra/terraform apply` yourself. Build
before each code deployment: Terraform packages `dist/strava-webhook/index.js` and
uses its archive hash to detect changes. The verification token is marked sensitive
but is stored in Terraform state and Lambda environment configuration (encrypted at
rest by Lambda). Do not commit state, plans, secrets, or local variables files.
Restrict access to local state and use an encrypted remote backend before sharing it.
This token is not a Strava OAuth token or API client secret.

After deployment, test verification from the repository root:

```bash
curl --get "$(terraform -chdir=infra/terraform output -raw strava_webhook_url)" \
	--data-urlencode 'hub.mode=subscribe' \
	--data-urlencode 'hub.challenge=local-test' \
	--data-urlencode "hub.verify_token=$TF_VAR_strava_verify_token"
```

Expected response: `{"hub.challenge":"local-test"}`. Do not share request URLs
containing the verification token. Keep the same token available for later Terraform
plans and applies. The execution role can write its own logs with 14-day retention,
perform `PutItem` only on `STRAVA#ATHLETE#*` partitions in the app table, and use the
table's KMS key only through DynamoDB. It cannot query users, read tokens, or delete records.
Garmin is optional through `webhook_lambda_arns.garmin`; existing external Strava
handlers remain supported through `webhook_lambda_arns.strava`.

### Subscription Setup

1. Build and deploy this handler with `enable_strava_webhook = true` and your existing
	verification token. Always preserve these settings on subsequent plans and applies.
2. Run the GET test above. It must return `{"hub.challenge":"local-test"}`.
3. Register a Strava webhook subscription using the callback URL, the same verify
	token, and your Strava application's Client ID and Client Secret. Do not commit
	or share the Client Secret; it is not needed by this ingestion Lambda.
4. Set `strava_subscription_id` to the numeric `id` returned by Strava (not Client ID
	or athlete ID), then review a fresh plan and apply. If already registered, retrieve
	the existing subscription rather than creating another one. Until the ID is
	deployed, POST deliveries receive 503 and rely on Strava's finite retry window.
5. Trigger a real Strava event and inspect the inbox item in the DynamoDB console.
	Repeated delivery of the same payload must retain the first record and timestamp.

Webhook inbox keys and fields are documented in
[DYNAMODB_SCHEMA.md](infra/terraform/modules/dynamodb/DYNAMODB_SCHEMA.md).
Webhook writes are atomic, but `RECEIVED` means durable receipt only. The optional
worker must complete processing before an event becomes `PROCESSED` or `IGNORED`.
Strava does not sign these POST requests;
subscription ID matching is a filter, not authentication. Treat inbox data as untrusted
until a worker verifies the user's active OAuth connection. The handler never logs
tokens or event bodies. SDK attempts are bounded to avoid blocking the webhook on
long AWS retries; failed deliveries must be retried by the sender.

## Strava Activity Worker

The optional pipeline is DynamoDB Streams -> worker Lambda -> Strava API -> workout
records in the same table. Only new inbox INSERTs are delivered; connection updates,
workout writes and event-status updates do not trigger processing loops. Provider
mapping uses `GSI1PK = STRAVA#<athleteId>` followed by a consistent connection read.
The worker verifies active consent, decrypts tokens with the OAuth encryption context,
refreshes near-expiry tokens, and persists newly encrypted credentials before fetching.
Conditional updates prevent overwriting tokens from a newer login. One reserved
worker execution serializes refreshes; the account must have sufficient Lambda
concurrency quota for one reservation while preserving AWS's unreserved minimum.

### Staged Deployment

Build both Lambda artifacts from the repository root:

```bash
npm run build
```

Preserve your existing webhook settings, verification token and registered subscription
ID. Set these additional values in your local Terraform variables file:

```hcl
enable_strava_worker             = true
strava_worker_processing_enabled = false
```

Review `terraform -chdir=infra/terraform plan` before applying yourself. This enables
`NEW_IMAGE` Streams in place on the existing table and provisions the worker, IAM,
14-day logs, an encrypted failure queue and a Secrets Manager secret container.
It must not replace the DynamoDB table, KMS key or existing webhook resources.

After apply, retrieve `terraform -chdir=infra/terraform output -raw strava_oauth_secret_arn`.
In **AWS Secrets Manager -> that secret -> Retrieve secret value -> Edit** (or the
console's **Store a new secret value** action for an empty container), add:

```json
{
	"client_id": "290868",
	"client_secret": "YOUR_STRAVA_APPLICATION_CLIENT_SECRET"
}
```

Use the application's actual Client Secret, not an OAuth access/refresh token or
webhook verify token. This is the same application credential used locally by Auth.js.
Terraform creates no secret version, so the credential does not enter Terraform state.
Secrets Manager has a separate monthly storage/API cost (typically about $0.40 per
secret/month before credits; check current regional pricing). The worker receives
only its ARN and can read only that secret. It uses the existing KMS key.

Once the secret is populated, set `strava_worker_processing_enabled = true`, review
another plan, and apply it yourself. The stream mapping uses `LATEST`: old inbox
rows are not backfilled, and events outside the 24-hour stream retention cannot be
recovered from the stream. After activation, change the title of an activity visible
to your granted Strava scopes, then refresh the app. A workout should appear with
sport, start date, distance, moving time and elevation. Deploy the automatic history
extension below to import earlier activities as well.

### Failure Handling And Safety

- Completed event IDs skip processing. Workout IDs are stable; older event versions
	cannot overwrite newer workouts or deletion tombstones. This is retry-safe processing,
	not a guarantee of exactly-once external API execution. Events over five minutes in
	the future are rejected before any credentials are accessed.
- Activity responses are schema-validated and their athlete/activity IDs must match
	the event. Delete notifications are confirmed by a Strava 403/404 response; an
	unsigned notification alone cannot delete an existing activity.
- A deauthorization notification checks current API access. Expired tokens are
	refreshed before treating an authorization failure as revoked. Confirmed invalid
	refresh credentials mark the connection `REVOKED` and remove encrypted tokens.
	Invalid application credentials instead remain retryable configuration failures.
	Stored workouts are hidden for revoked accounts, not physically purged by this step.
- OAuth reauthorization races fail conditional writes and are retried using the new
	connection. Old deauthorization notifications from before the current login are
	ignored. A refresh response lost before encrypted persistence can require the user
	to authorize again, because external token rotation and DynamoDB cannot be atomic.
- Network errors, 5xx, missing mappings and database/KMS failures remain failures.
	Partial-batch responses stop at the first failed sequence; AWS retries at most ten
	times and retains records for at most 24 hours. A sustained rate limit may exhaust
	retries. With the history extension deployed, explicit quota waits use the durable
	pending-webhook index and minute scheduler instead of consuming these short retries.
- Check **Lambda -> worker -> Monitor -> CloudWatch logs**, mapping iterator age and
	`strava_worker_failure_queue_url`. Failed invocation metadata stays in the SQS queue
	for 14 days. No email notification is configured. DynamoDB-stream SQS failure
	destinations contain stream/sequence metadata, not guaranteed full event payloads;
	the durable inbox retains the original payload with status `RECEIVED` for recovery.
	SQS is a failure destination, not an automatic replay consumer.
- To recover an event after fixing the cause, locate its retained inbox payload and
	invoke the worker manually with an INSERT-shaped DynamoDB Stream test event containing
	`entityType.S = STRAVA_WEBHOOK_EVENT`, `status.S = RECEIVED`, `payload.S` containing
	that payload, and a `SequenceNumber`. This performs real API calls/writes and should
	only be done by an operator. Updating the inbox status alone does not replay it,
	because the mapping intentionally filters MODIFY events.

The worker is opt-in and local tests use mock AWS providers/clients. No infrastructure
deployment or Strava API write is performed by the test suite. Garmin, AI coaching,
push notifications are outside this stage.

## Automatic Lifecycle History

After OAuth credentials are saved, login enqueues a metadata-only per-user history
job. Login does not fetch activities; enqueue failures are logged without exposing
credentials and do not prevent login. The account panel offers **Synchronizuj historie**
and shows queued/running/waiting/failed/succeeded state, processed/changed counts and
the last successful cutoff. While visible and active it refreshes at most every 30
seconds (60 seconds during waits); it does not poll Strava from the browser.

The first import pages through all accessible activity summaries with `per_page=200`
and a fixed `before` cutoff. Subsequent logins import since the last successful
cutoff minus seven days. Repeated automatic requests within 15 minutes are suppressed;
manual requests have a one-minute cooldown. One active job is reused rather than
duplicated. Expanded `activity:read_all` consent starts a full pass when the previous
job is no longer active. Private activities still require that scope; the default
login requests only `activity:read`.

### Data And Cost Boundaries

- Retain normalized per-activity metrics, not raw API JSON, GPS, maps, photos, FIT/GPX
	files, descriptions or second-by-second streams. No S3 bucket or import queue is added.
	Activity names in list-page checkpoints are bounded to 200 characters.
- Only activities in the latest 90 days with explicitly expected but missing heart-rate
	or power metrics request the detail endpoint. Missing sensors do not cause a detail
	request for every activity. No physiology, injury cause or intensity zones are inferred.
- Each invocation handles at most ten activities and yields before the Lambda deadline.
	It caches only the current normalized page (at most 200 activities), not the archive,
	and persists page/offset/progress under a lease. A 200-row page therefore may span
	roughly 20 minute ticks. Other users and pending webhooks share that worker; large
	archives can take hours. The page is not downloaded again for each chunk.
- Stable workout keys and metric fingerprints skip unchanged writes. History cannot
	overwrite webhook-owned records or deletion tombstones. Webhooks and imports share
	revision-checked transactions that update the workout and weekly/monthly/lifetime
	totals by deltas, rather than incrementing totals again on a retry. Aggregates
	separate cycling, running and other sports; the app shows overall lifetime totals.
- Legacy workouts are included in aggregates when touched by a webhook or import;
	totals may be partial until the initial import finishes. The lightweight history
	remains stored per activity to support idempotent updates and corrections.
- Both import and webhook API clients reserve an atomic shared budget in DynamoDB:
	defaults are 200 read calls/15 minutes and 2000/day, 400 overall/15 minutes and
	4000/day. Import stops at 90% to leave a webhook reserve. Response headers update
	observed quotas and usage; `429` persists a quarter-hour/daily/Retry-After wait.
	Auth.js's own OAuth/profile requests and external tools are not routed through this
	worker limiter; later response headers reconcile their usage, so the reserve matters.
- A `rate(1 minute)` EventBridge rule resumes due work with webhook priority. No scan
	of user partitions or permanent Lambda sleep is used. One reserved worker invocation
	serializes token refreshes. Checkpoints, temporary API budgets and this schedule have
	AWS request/compute costs; this is not a zero-cost guarantee.
- DynamoDB TTL uses only `ttlEpoch`. Short-lived rate counters expire after their
	windows plus one day; completed inbox events expire after 14 days. Active jobs,
	credentials, workouts, tombstones and aggregate records have no TTL. Existing
	pre-extension inbox rows without TTL/index metadata are not retroactively migrated.
	TTL removal is asynchronous. After inbox deduplication expires, a repeated event can
	fetch again, but workout revisions/fingerprints prevent duplicate aggregate counts.

### Deploy And Test

From the repository root, run `npm run build` and review
`terraform -chdir=infra/terraform plan`. Preserve the registered subscription, verify
token, `enable_strava_webhook = true`, `enable_strava_worker = true`, and the existing
`strava_worker_processing_enabled` setting. Apply the reviewed update yourself. It
updates Lambda code/IAM and stream filters, enables technical-record TTL, and adds a
schedule, target and invocation permission. It must not replace the table/KMS key.
The schedule follows `strava_worker_processing_enabled`; when false, jobs can queue
but do not run. Keep the existing Secrets Manager client credentials configured.

The local/hosted Next.js identity additionally needs item-level GetItem/PutItem/UpdateItem
on its user's `SYNC#STRAVA` record and Query on its own `SUMMARY#LIFETIME#` records.
No new environment secret is required. Personal administrator credentials already
have these permissions for local development; production should use a scoped role.

After deployment, log in again or press the history button. This performs real reads
from Strava and writes to AWS. Inspect `SYNC#STRAVA` and `SUMMARY#...` under your user
partition and verify that training totals stabilize on repeat import. A terminal
failure preserves its cursor for manual retry; rate-limit waits resume automatically.
An authorization failure requires reconnecting Strava. If the worker cannot persist
its checkpoint, lease expiry and the scheduled index allow later recovery.

The import does not infer missing/deleted historical activities from absence in a
page, and a seven-day incremental window does not detect arbitrary edits to older
activities when webhook delivery was missed. Webhooks remain responsible for those
changes. A full historical reconciliation/export and alert emails are not implemented.

---
*Created for private, non-commercial use.*
