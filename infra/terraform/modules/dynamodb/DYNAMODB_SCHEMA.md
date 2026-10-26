# DynamoDB single-table schema

The table uses string partition and sort keys (`PK`, `SK`). Each item should also include an `entityType` attribute so application code can identify its shape.

| Entity | PK | SK | Purpose |
| --- | --- | --- | --- |
| User profile | `USER#<userId>` | `PROFILE` | Athlete preferences, zones, and account settings |
| Provider connection | `USER#<userId>` | `CONNECTION#STRAVA` or `CONNECTION#GARMIN` | Provider identifiers and OAuth connection metadata |
| Strava workout | `USER#<userId>` | `ACTIVITY#STRAVA#<activityId>` | Stable activity identity for updates and deletion tombstones |
| Health metrics | `USER#<userId>` | `HEALTH#<date>` | HRV, sleep, Body Battery, and daily recovery metrics |
| Push subscription | `USER#<userId>` | `PUSH#<subscriptionId>` | Web Push endpoint and subscription keys |
| BYOK credential | `USER#<userId>` | `SECRET#<provider>` | User-owned LLM API key metadata and encrypted value |
| Strava webhook inbox | `STRAVA#ATHLETE#<ownerId>` | `WEBHOOK#<sha256>` | Durable event receipt and duplicate detection before OAuth/user resolution |
| History job | `USER#<userId>` | `SYNC#STRAVA` | Leased import cursor, page checkpoint, status and successful watermark |
| Training aggregate | `USER#<userId>` | `SUMMARY#WEEK#<monday>#<sport>`, `SUMMARY#MONTH#<month>#<sport>`, `SUMMARY#LIFETIME#<sport>` | Idempotent per-sport volume totals |
| API quota | `STRAVA#RATE_LIMIT` | `STATE` or `<READ/TOTAL>#<seconds>#<window>` | Shared limits, usage and cooldowns |

`GSI1` maps provider identities back to an internal user:

| Attribute | Value |
| --- | --- |
| `GSI1PK` | `STRAVA#<athleteId>` or `GARMIN#<providerUserId>` |
| `GSI1SK` | `USER#<userId>` |

Active workouts use a second GSI1 access pattern: `GSI1PK = USER#<userId>` and
`GSI1SK = ACTIVITY#<start_date>#STRAVA#<activityId>`. Descending queries return the
latest 50 keys, followed by projected consistent BatchGetItem reads of the base table.
Deleted workouts omit GSI keys. Items that need neither provider lookup nor activity
ordering omit GSI keys. GSI1 uses `KEYS_ONLY` projection.

Strava sign-in assigns the stable internal ID `strava-<athleteId>`. A transaction
updates the user profile (preserving its original `createdAt`) and writes
`USER#strava-<athleteId>/CONNECTION#STRAVA` with `status = ACTIVE`, athlete ID, name,
granted scopes, expiry and authorization timestamps. The connection's
`encryptedTokens` is a Base64 KMS ciphertext containing both OAuth tokens, using
encryption context `{ userId: "strava-<athleteId>", provider: "strava" }` and
`encryptionVersion = 1`. The worker uses this context for decryption. Tokens are
never stored as plaintext connection attributes or included in application sessions.
Connection-summary reads project metadata only, excluding `encryptedTokens`.

Webhook inbox items use `entityType = STRAVA_WEBHOOK_EVENT`, `status = RECEIVED`,
an ISO `receivedAt`, and a JSON-string `payload` containing validated event fields.
The digest covers subscription ID, owner, object type/ID, aspect, event timestamp,
and updates sorted by key. Conditional `PutItem` prevents overwriting the first
receipt, including concurrent deliveries. Retries with the same normalized payload
are acknowledged without an additional record; this does not guarantee exactly-once
downstream processing. Pending inbox rows use `GSI1PK = STRAVA#WEBHOOK#PENDING`
and `GSI1SK = RETRY#<12-digit-due-epoch>#<event-hash>`. Completion removes these keys
and sets `ttlEpoch` 14 days ahead. Incomplete rows do not expire. Legacy rows are
not automatically indexed or assigned TTL. Deduplication lasts while the item exists.

Activity create/update/delete and athlete deauthorization notifications can be
stored. The optional stream worker transitions inbox status from `RECEIVED` to
`PROCESSED` or `IGNORED`, with `processedAt`. Failures leave it `RECEIVED` for retry
and operator recovery. Enabling the worker does not scan historical inbox items.
The public webhook is not cryptographically authenticated by its subscription ID.

Workout records use `entityType = WORKOUT`, `provider = strava`, `status = ACTIVE`,
`activityId`, numeric `eventTime`, ISO `updatedAt`, and validated Strava metrics:
`name`, `sport_type`, `start_date`, `distance` (metres), `moving_time`/`elapsed_time`
(seconds), optional `total_elevation_gain` (metres), heart-rate and power values.
Missing optional telemetry stays absent. Stable activity keys prevent an update
from creating duplicate workouts; chronological GSI keys can change with start date.

Workout writes transactionally check that the connection is still active and has the
same encrypted token generation. They use a new `revision` for optimistic concurrency,
`metricsHash` for unchanged detection, `summaryVersion = 1`, `source = HISTORY/WEBHOOK`
and `detailLevel = SUMMARY/DETAIL`. Webhooks reject lower `eventTime` values; history
uses an event-time baseline of zero and cannot overwrite webhook-owned rows. Confirmed
deletions replace the record with a `DELETED` tombstone containing identity/version
metadata only, preventing older events from resurrecting it. No tombstone TTL is set.
Active API state overrides forged deletion hints. Revocation conditionally removes
`encryptedTokens` and records `status = REVOKED` and `revokedAt`; provider mapping is
retained so subsequent events can be ignored without API access. Workouts are hidden
for inactive connections; physical data erasure is not implemented here.

An opt-in `NEW_IMAGE` stream emits item changes. The event-source mapping filters
inbox INSERTs with `status = RECEIVED` and job INSERTs with `state = QUEUED`, so
progress MODIFYs cannot loop. Retry/DLQ metadata is separate from the durable payload.

History jobs use a unique `jobId`, `leaseId`/`leaseUntil`, fixed `after`/`before`,
`page`, `offset`, at most one normalized `pending` page, counters and error category.
Active jobs use `GSI1PK = STRAVA#SYNC#PENDING` and
`GSI1SK = SYNC#<12-digit-due-epoch>#<userId>`. A minute scheduler queries due jobs;
success/failure removes index keys. Checkpoint writes require both job and lease ID.
Successful jobs retain `lastSuccess` and `successReadAll` for incremental imports.
Status projections omit pending activity metadata and leases from the client.

Training summaries contain `entityType = TRAINING_SUMMARY`, `activityCount`,
`distance` (metres), `movingTime`/`elapsedTime` (seconds), `elevation` (metres),
and `updatedAt`. UTC Monday weeks and UTC calendar months are grouped separately
for CYCLING/RUNNING/OTHER. A workout revision transaction applies old/new deltas
to these records together with the workout; retries cannot double-count a revision.
Empty aggregate buckets can remain with zero totals. Aggregates are incomplete until
legacy activities have been touched/imported. They contain no inferred medical context.

Quota counters reserve both read and total budgets for 900-second and UTC-day windows.
Only counters and completed inbox rows set `ttlEpoch`; the table TTL deliberately
does not use OAuth's `expiresAt`. STATE retains the latest observed caps/cooldown.

The table is encrypted at rest with a customer-managed KMS key. Store API keys and OAuth tokens only in secret items, never in logs or client-visible responses. For application-level isolation from principals that can read the table, encrypt those values with AWS KMS before writing them and decrypt only in the trusted backend.