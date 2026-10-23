# DynamoDB single-table schema

The table uses string partition and sort keys (`PK`, `SK`). Each item should also include an `entityType` attribute so application code can identify its shape.

| Entity | PK | SK | Purpose |
| --- | --- | --- | --- |
| User profile | `USER#<userId>` | `PROFILE` | Athlete preferences, zones, and account settings |
| Provider connection | `USER#<userId>` | `CONNECTION#STRAVA` or `CONNECTION#GARMIN` | Provider identifiers and OAuth connection metadata |
| Workout | `USER#<userId>` | `ACTIVITY#<timestamp>#<activityId>` | Chronological activity and training data |
| Health metrics | `USER#<userId>` | `HEALTH#<date>` | HRV, sleep, Body Battery, and daily recovery metrics |
| Push subscription | `USER#<userId>` | `PUSH#<subscriptionId>` | Web Push endpoint and subscription keys |
| BYOK credential | `USER#<userId>` | `SECRET#<provider>` | User-owned LLM API key metadata and encrypted value |

`GSI1` maps provider identities back to an internal user:

| Attribute | Value |
| --- | --- |
| `GSI1PK` | `STRAVA#<athleteId>` or `GARMIN#<providerUserId>` |
| `GSI1SK` | `USER#<userId>` |

Items that do not need provider lookup should omit `GSI1PK` and `GSI1SK`. The index uses `KEYS_ONLY` projection; fetch the full item from the base table after resolving the user.

The table is encrypted at rest with a customer-managed KMS key. Store API keys and OAuth tokens only in secret items, never in logs or client-visible responses. For application-level isolation from principals that can read the table, encrypt those values with AWS KMS before writing them and decrypt only in the trusted backend.