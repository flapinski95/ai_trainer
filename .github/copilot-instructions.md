# GitHub Copilot System Instructions

## Project Context
You are working on `ai_trainer`, a proactive, endurance-sports Progressive Web App (PWA) built for cyclists and runners (integrating Strava API v3 and Garmin Connect Developer Program v2.0 via OAuth2 PKCE).
Primary Use Case: Stateful AI coach chat analyzing workouts, daily HRV, sleep scores, Body Battery, heart rate/power zones, athletic profile, and injury history to provide actionable recovery and training advice.

## Tech Stack & Current Architecture
- Frontend: Next.js (App Router), Tailwind CSS, Auth.js (HTTP-only sessions), PWA (Web Push Notifications, Mobile-First `100dvh` UI)
- Backend: AWS Serverless (API Gateway HTTP API, AWS Lambda, DynamoDB Single-Table Design, Streams, EventBridge, Secrets Manager) managed via Terraform
- AI Layer: Vercel AI SDK (`ai`), `streamText` streaming, Multi-LLM support (Gemini 1.5 Flash/Pro, Claude 3.5 Sonnet, GPT-4o)
- Security: User API keys and OAuth tokens encrypted via AWS KMS in DynamoDB. In-memory KMS key caching in Lambda execution scope.

## Data Source Routing & Hybrid Logic
- Workout Source: Strava (if connected) takes precedence for activity telemetry; Garmin acts as fallback if Strava is absent.
- Health Source: Garmin Connect (Starter Access PUSH) handles daily metrics (HRV, Sleep, Body Battery, Resting HR).
- Never double-count activities when both providers are connected.

## Core Architectural Rules
1. AI Authorization (100% BYOK):
   - Users provide their own API keys (Google AI Studio, Anthropic, OpenAI) via settings, stored as KMS-encrypted strings in `USER#<userId>`.
   - Do NOT implement centralized token billing, payment walls, or Stripe for LLM usage.
2. Webhooks & Flow Triggers:
   - Webhooks from Strava/Garmin trigger AWS Lambda functions.
   - Post-Workout Flow: Strava activity webhook -> Web Push -> User opens app directly into a new Post-Workout Debrief Chat (`CHAT#<sessionId>`).
   - Conditional Morning Flow: Web Push triggers ONLY on recovery anomalies (e.g., HRV drop, Resting HR +5bpm, Body Battery < 55) or key planned intervals. Zero push spam on normal recovery days.
3. Data Model & Stateful Chat:
   - Single-Table Schema handles Users, Health Profiles (`injuries`, `primaryGoal`), Garmin Metrics (`METRIC#<date>`), Strava History, Chat Sessions (`CHAT#<sessionId>`), and Messages (`MSG#<timestamp>`).
   - Background Memory Extraction: Asynchronously extract key long-term facts (injuries, goals, equipment changes) from chats into `USER#<userId>` / `SK: METADATA` using lightweight model calls after streaming completes.
   - Equipment tracking (chain wear, shoe mileage) is calculated deterministically via TypeScript logic in the UI/backend—never via LLM token prompts.
4. UI & Design System (Clean Ivy League / Heritage Athletic Theme):
   - Mobile-First responsive PWA design (`standalone` mode, safe areas, `100dvh`, bottom navigation bar).
   - Clean, non-overstyled aesthetic: 90% modern sans-serif (Inter/Geist/SF Pro) for readable telemetry & chat, 10% elegant serif (Newsreader/Fraunces) restricted strictly to app identity and section headers.
   - Light Mode Palette: Off-white canvas (`#FDFBF7`), clean card surfaces (`#FFFFFF`), subtle borders (`#EFECE6`), rich deep burgundy accent (`#7A1A28`), and warm charcoal text (`#1C1917`).
   - Dark Mode Palette: Warm dark charcoal canvas (`#121110`), card surfaces (`#1E1C1A`), subtle borders (`#2E2B28`), brightened burgundy accent (`#9E2A3B`), and cream text (`#F4F1EA`).
5. Security, Versioning & Resilience:
   - Encrypt all tokens and BYOK keys in DynamoDB using AWS KMS.
   - Maintain backward compatibility in DynamoDB schema: strictly add optional fields (`z.optional()`) with Zod schemas.
   - Implement graceful error handling for missing telemetry fields or 401/429 LLM provider errors without breaking the Next.js UI.
   - For long chat sessions (`CHAT#<sessionId>`), apply token pruning (keep last 6 messages verbatim + auto-summarize previous history context).
   - Ensure Service Worker for PWA Web Push complies with iOS Safari user-gesture requirements (`NetworkFirst` strategy for API/routes).
   - TypeScript code must be strictly typed.
   - Do NOT add comments to the code unless explicitly asked by the user.

## Active Roadmap for MVP v1.0

### Step 1: Garmin Production Verification
- Verify live OAuth2 PKCE authorization flow and token storage in KMS.
- Test actual Garmin Starter Access PUSH payload parsing in Lambda for `METRIC#<date>` records.

### Step 2: BYOK Key Management & Chat Schema
- Add BYOK input form in PWA settings (encrypting keys via KMS to `USER#<userId>`).
- Extend DynamoDB Single-Table schema for Chat Sessions (`CHAT#<sessionId>`) and Message persistence (`MSG#<timestamp>`).

### Step 3: Vercel AI SDK Integration
- Implement `/api/chat/route.ts` using `streamText`.
- Build context assembly pipeline: User BYOK Key + Health Profile + Latest Strava Activity + Garmin Health Metrics (Body Battery/HRV) + Last 6 messages.
- Implement token pruning and asynchronous background memory extraction into `USER#<userId>` / `SK: METADATA`.

### Step 4: PWA Web Push & Ivy League UI Polish
- Apply Tailwind CSS color tokens (`#FDFBF7` / `#7A1A28` Light, `#121110` / `#9E2A3B` Dark) with 90/10 typography rules.
- Configure Service Worker (`sw.ts`), Web Push endpoints, and post-workout Web Push trigger to open `CHAT#<sessionId>`.

### Step 5: Final Public Deployment, Domain & Production Push (Deferred)
Complete this stage last, after Steps 1-4. These items remain pending; implemented code and local notification tests do not mean production deployment is complete. Domain purchases, public deployment, paid resources, and `terraform apply` require explicit user approval.

- [ ] Use Vercel as the proposed Next.js hosting target; keep Lambda, DynamoDB, KMS, and Secrets Manager in AWS (`eu-north-1`). Confirm the hosting choice and costs before deployment.
- [ ] Start with a stable public Vercel HTTPS address if a custom domain is not yet needed. AWS Lambda cannot reach `localhost:3000`; a public HTTPS tunnel is an option for temporary local checks only.
- [ ] Choose and register a custom domain when approved (e.g. OVHcloud/cyber_Folks for `.pl`, or Cloudflare Registrar for supported extensions). Check renewal pricing, enable registrar 2FA and automatic renewal, add the domain in Vercel, and configure the DNS records Vercel specifies. Verify HTTPS before switching traffic.
- [ ] Configure production Auth.js, provider OAuth, AWS, and Push environment variables securely. Grant the app only the required DynamoDB/KMS permissions; never expose server credentials through `NEXT_PUBLIC_*` or commit secrets.
- [ ] Preserve the VAPID key pair and set `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `WEB_PUSH_TRIGGER_SECRET` on the deployed app. Only the VAPID public key may be public.
- [ ] Update the canonical app URL and Strava/Garmin OAuth callback settings for the final origin. Keep provider ingestion webhooks pointing to their managed AWS endpoints; verify login and account linking after the switch.
- [ ] Prepare updated Push, Strava worker, and Garmin worker bundles when authorized. Provision Terraform Push resources with `enable_web_push = true`, `web_push_processing_enabled = false`, and `web_push_endpoint = "https://<public-app-host>/api/push/workout"`; review the plan before applying.
- [ ] Ensure the Push endpoint is reachable from AWS without interactive login or hosting deployment protection, while retaining its server-to-server Bearer authentication. It must use the same DynamoDB table and user identities as the app storing subscriptions.
- [ ] Populate the KMS-encrypted Secrets Manager secret identified by `web_push_secret_arn` with `{"web_push_trigger_secret":"<same value as the app WEB_PUSH_TRIGGER_SECRET>"}` outside Terraform. Never store its value in Terraform variables/state, source code, logs, or browser code.
- [ ] After configuring the app and secret, enable `web_push_processing_enabled = true` and the relevant provider processing flag, review the plan, and deploy. Verify the provider worker receives `WEB_PUSH_ENABLED = "true"` and the Push stream mapping is enabled.
- [ ] Re-enable Push subscriptions on the final app origin; subscriptions from localhost, preview URLs, or a previous domain do not transfer automatically. On iOS, verify the installed Home Screen PWA and user-gesture permission flow; on macOS, verify browser/system notification permissions and Focus settings.
- [ ] Verify production chat streaming and background memory persistence, then a new webhook workout through atomic Push job creation, Lambda delivery, and notification click to `/chat?sessionId=...`. Verify Strava precedence, no notifications for history/imports/edits, retry/deduplication behavior, expired subscriptions, and failure queue recovery. A local `showNotification()` check alone does not verify remote Web Push.
- [ ] Follow the detailed deployment and recovery procedure in [the Web Push guide](../app/api/push/README.md). Mark this stage complete only after the end-to-end checks pass; do not send historical workouts retroactively.