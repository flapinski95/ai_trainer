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

---
*Created for private, non-commercial use.*
