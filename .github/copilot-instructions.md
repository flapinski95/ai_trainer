# GitHub Copilot System Instructions

## Project Context
You are working on `ai_trainer`, a proactive, endurance-sports Progressive Web App (PWA) built for cyclists and runners (integrating Strava and Garmin Connect).
Primary Use Case: Daily AI coach analyzing workouts, HRV, sleep, Body Battery, and heart rate zones to provide actionable recovery/training advice.

## Tech Stack
- Frontend: Next.js (App Router), Tailwind CSS, PWA (Web Push Notifications)
- Backend: AWS Serverless (API Gateway HTTP API, AWS Lambda, DynamoDB Single-Table Design) managed via Terraform
- AI Layer: Vercel AI SDK (`ai`), Multi-LLM support (Gemini 1.5 Flash/Pro, Claude 3.5 Sonnet, GPT-4o)
- Integrations: Strava API v3, Garmin Connect Developer Program (Starter Access / Business via Push Webhooks)

## Core Architectural Rules
1. AI Authorization (100% BYOK):
   - Users provide their own API keys (Google AI Studio, Anthropic, OpenAI) stored in DynamoDB.
   - Do NOT implement centralized token billing or payment walls for LLM usage.
2. Webhooks & Data Flow:
   - Webhooks from Strava/Garmin trigger AWS Lambda functions.
   - Process incoming telemetry into DynamoDB -> Send Push Notification to user -> Open PWA chat with pre-loaded workout context.
3. Security & Code Style:
   - Encrypt user API keys and OAuth tokens in DynamoDB using AWS KMS.
   - Set Lambda execution timeouts to 30s with streaming responses (Vercel AI SDK).
   - Implement graceful error handling for missing telemetry fields or 401/429 LLM provider errors.
   - TypeScript code must be strictly typed.
   - Do NOT add comments to the code unless explicitly asked by the user.

## Next Tasks
- Scaffold Terraform infrastructure (`main.tf`, `variables.tf`, DynamoDB Single-Table schema).
- Create API Gateway routes for Webhooks (`/webhooks/strava`, `/webhooks/garmin`) and Next.js integration.
