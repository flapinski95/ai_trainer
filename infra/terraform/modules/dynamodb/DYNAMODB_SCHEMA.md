# DynamoDB single-table schema

The table uses string partition and sort keys (`PK`, `SK`). Each item should also include an `entityType` attribute so application code can identify its shape.

| Entity | PK | SK | Purpose |
| --- | --- | --- | --- |
| User profile | `USER#<userId>` | `PROFILE` | Athlete preferences, zones, and account settings |
| Athlete physiology | `USER#<userId>` | `METADATA` | Optional individual HR thresholds, FTP and power-meter ownership alongside durable profile facts |
| Provider connection | `USER#<userId>` | `CONNECTION#STRAVA` or `CONNECTION#GARMIN` | Provider identifiers and OAuth connection metadata |
| Chat session | `USER#<userId>` | `CHAT#<sessionId>` | Session title, timestamps and message count |
| Chat message | `USER#<userId>` | `MSG#<sessionId>#<timestamp>#<messageId>` | Ordered user or assistant message for one session |
| Athlete memory | `USER#<userId>` | `ATHLETE_MEMORY` | Durable coaching preferences, confirmed notes and deterministic 90-day benchmarks |
| Strava workout | `USER#<userId>` | `ACTIVITY#STRAVA#<activityId>` | Stable activity identity for updates and deletion tombstones |
| Health metrics | `USER#<userId>` | `HEALTH#<date>` | HRV, sleep, Body Battery, and daily recovery metrics |
| Push subscription | `USER#<userId>` | `PUSH#<subscriptionId>` | Web Push endpoint and subscription keys |
| BYOK credential | `USER#<userId>` | `SECRET#<provider>` | User-owned LLM API key metadata and KMS-encrypted value |
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

AI credentials use `entityType = AI_CREDENTIAL`, `provider`, `encryptedKey`,
`encryptionVersion = 1` and `updatedAt`. KMS encryption context is
`{ userId, provider }`. Only a trusted server-side call decrypts the key; settings
views project provider and timestamp metadata only. Chat sessions use
`entityType = CHAT_SESSION`, `sessionId`, `title`, `createdAt`, `updatedAt` and
`messageCount`. Messages use `entityType = CHAT_MESSAGE`, `sessionId`, `messageId`,
`role`, `content` and `createdAt`. Appending a message and updating its session
timestamp/count is a DynamoDB transaction. The message sort-key prefix allows an
ordered query scoped to one user and session.

Athlete memory uses `entityType = ATHLETE_MEMORY`. Its Zod-validated fields are
optional for backward compatibility: `focus_goal` (up to 160 characters),
`preferred_tone` (up to 80 characters), `coaching_notes` (up to 10 notes of 200
characters each), and `derived_metrics`. The latter contains optional `max_hr_90d`
(bpm), `peak_np_90d` (watts), and `key_segments_benchmarks` (up to five segments).
Each benchmark has `segment_id`, `elapsed_seconds`, ISO `achieved_at`, and optional
`average_power` (watts) and `average_hr` (bpm). Segment identity is not effort identity.

Context assembly refreshes metrics from available active workouts in the trailing
90-day window, preferring Strava over Garmin without double-counting. NP is read
only from explicit normalized-power fields, never inferred from weighted or average
power. Segment benchmarks retain the fastest elapsed time per segment and select
the five most recently achieved benchmarks. These are observed values, not FTP,
physiological HRmax, or lifetime records. A successful empty history clears expired
metrics; a failed history read neither overwrites stored metrics nor exposes stale
metrics to the model. Metric writes update only `derived_metrics`, `derivedUpdatedAt`
and the entity type.

After chat streaming, structured extraction stores only athlete-stated or confirmed
goals, communication preferences and durable coaching conclusions. Notes merge with
deduplication and a ten-note limit. `memoryRevision` protects concurrent updates with
up to three attempts; `memoryUpdatedAt` records their timestamp. The existing
`METADATA` injury, equipment and primary-goal extraction remains intact. No migration,
index or Terraform apply is required. The server role needs reads and `UpdateItem`
access to this key. Context includes an XML-escaped `<athlete_memory>` JSON block,
limited to 1100 UTF-8 bytes; older notes and then less recent segment benchmarks are
omitted first. Memory content remains untrusted data, never system instructions.

## Individual Physiology And Zones

The authenticated settings form reads and updates `USER#<userId>/METADATA`.
All physiology fields are optional in `athletePhysiologySchema`; older records
remain valid. Stored integer fields are `max_hr` (50-250 bpm), `z2_hr_upper`
(40-240 bpm), `lthr` (50-249 bpm), and `ftp_watts` (20-1500 W), plus optional
boolean `has_power_meter`. `physiologyUpdatedAt` records the last save. LTHR must
be below HRmax, and a manual Z2 ceiling must leave at least three bpm below LTHR
or, without LTHR, HRmax. Blank numeric inputs remove only their corresponding
attributes. Updates preserve injuries, equipment, goals and memory revisions.

`buildAthleteZones` computes the same five-zone preview used by settings and chat.
With LTHR, default upper boundaries are `round(85% LTHR)-1`,
`round(90% LTHR)-1`, `round(95% LTHR)-1`, and `LTHR-1`; Z5 begins at LTHR.
Without LTHR, HRmax boundaries are floor-rounded 60%, 70%, 80% and 90% of HRmax.
A manual `z2_hr_upper` overrides the Z2 ceiling; neighboring boundaries are
adjusted to keep all five ranges ordered and nonempty. HRmax, when configured,
caps Z5. A Z2 ceiling alone cannot define all five HR zones. These computed
boundaries are a coaching model, not laboratory measurements.

Power uses floor-rounded 55%, 75%, 90% and 105% of FTP as Z1-Z4 ceilings.
Z5 is unbounded above 105%, combining higher intensities into a five-zone model.
Each range uses an exclusive lower `above` boundary and inclusive `up_to` ceiling.
Average HR of exactly 160 bpm belongs to Z2 when the athlete's Z2 ceiling is 160;
161 bpm does not. No individual zone is inferred from historical observed maxima.

`ContextBuilder` prepends `<athlete_zones>` containing settings, HR calculation
method and ranges. Activity `hr_zone` and `power_zone` classify average values;
`np_zone` classifies explicit normalized power. `hr_pct_max`, `hr_pct_lthr`,
`power_pct_ftp` and `np_pct_ftp` are percentages of a threshold, never time shares.
Power provenance distinguishes explicit sensor data, athlete-reported ownership,
estimated or unverified power, and unknown origin. Owning a power meter alone
does not prove a specific workout used it.

Legacy zone distributions retain provider zone numbers but not their boundaries.
They are exposed separately as `provider_hr_zones_distribution` and
`provider_power_zones_distribution`, with seconds and percentages of recorded
zone time. They cannot be reclassified as individual zones without samples or
matching boundaries; average values cannot reconstruct time in zones. When the
athlete disables effort-zone sharing, XML contains only
`<athlete_zones>{"shared":false}</athlete_zones>` and no activity zone annotations,
threshold percentages or provider zone distributions. Context prioritizes zones
and drops older activity summaries when needed to stay within the byte budget.

## Detailed Strava Context

Detailed activity requests use `GET /api/v3/activities/{id}?include_all_efforts=true`
through the existing rate gate and OAuth client. Activity ingestion and persisted
metrics optionally retain `segment_efforts`, `pr_count`, `achievement_count`,
`athlete_count`, `device_watts`, `average_speed` and `average_cadence`. All returned
segment efforts are stored, including identity, name, distance, elapsed/moving time,
signed `average_grade`, HR, cadence, power and explicit PR/KOM ranks. Grade can be
returned on the effort or its nested segment. All added fields are optional;
existing records remain valid. Future authorized history imports request details
for rides missing segments in the existing 90-day detail window, even if sensor
averages are present, while retaining rate limits and quota controls. Context
assembly does not call Strava or start a backfill. Previously discarded details
require a subsequent authorized detail fetch and worker deployment to become stored.

Context activity fields include the title, exact `moving_time` and `elapsed_time`
in seconds, `stopped_time_s` (their nonnegative difference), `distance_m`,
`avg_speed_kmh`, `athlete_count` and `companions_count` (athlete count minus self).
Missing timing or companion information stays absent; no identities or stop causes
are inferred. Raw elapsed time must be at least moving time to expose stopped time.

Each included activity is serialized as an XML `<activity>` with `id`, `title`,
readable `moving_time`, `elapsed_time`, `total_rest_time`, `pr_count` and
`achievement_count` attributes when available. Its `<telemetry>` JSON retains
exact seconds and the remaining metrics. Its `<segment_efforts>` contains at most
six `<segment>` elements, prioritizing PR/KOM ranks, then maximum/average HR and
sensor-confirmed power. Each element includes available `id`, `name`, `distance`
(km), signed `grade` (%), `time` (elapsed), raw `distance_m`, `elapsed_time_s`,
`moving_time_s`, `avg_hr`, `max_hr`, `avg_cadence`, `avg_watts`, `pr_rank` and
`kom_rank`. `segment_efforts_total` counts stored efforts and `segment_efforts_count`
counts selected efforts; neither replaces the activity achievement counters.
The 4500-byte metadata budget excludes the selected segment blocks, so final
context can exceed it; older activity summaries may still be dropped. XML attribute
escaping covers quotes and special characters in names. Power fields remain subject
to the chat's physical-meter provenance rules. Missing ranks do not prove absence
of achievements, and missing segment arrays do not prove an activity had none.