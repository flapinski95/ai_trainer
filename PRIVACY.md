# Privacy Policy

**Last updated:** October 25, 2026

## 1. Introduction
This Privacy Policy applies to the **AI Endurance Coach** application ("the Application"). The Application is a private, non-commercial tool designed to process personal fitness and health data to provide customized training insights.

## 2. Information We Collect
Depending on the provider and permissions you grant, we collect:
- **Account connections:** Provider identifiers, granted permissions and encrypted OAuth credentials. Garmin and Strava are independent; Strava is not required.
- **Activity Data:** Available workout metrics and received Garmin activity JSON. Delivered activity details can include location/sensor samples. Strava history import retains normalized metrics without GPS tracks. FIT/GPX/TCX downloads are not performed.
- **Garmin Health & Wellness Data:** Complete JSON records delivered for enabled, approved summary types, including sleep, HRV, Body Battery, heart rate, stress, body composition, respiration, pulse oximetry, blood pressure, skin temperature, nutrition, hydration and breathing variations where available.
- **Women's Health Data:** Complete records only when the relevant Garmin permission is granted. These are sensitive personal data; availability depends on device, API access and your choices.

## 3. How We Use Your Data
We use the collected data strictly to:
- Generate personalized, natural language training feedback and recovery recommendations.
- Display activity summaries and historical trends within the Application interface.

## 4. Data Storage and Third-Party Services
- **Storage:** Access tokens and aggregated health/workout metrics are securely stored in encrypted cloud databases (AWS DynamoDB) using AWS KMS encryption.
- **AI Processing:** The current integration does not send these records to an LLM. A future AI feature requires separate configuration and a clear explanation of the data sent to the selected provider; connecting Garmin alone does not authorize automatic disclosure of all medical records to an LLM.
- **Data Sharing:** We do not sell or monetize your data. AWS processes stored data for the Application. External font loading may contact the font provider; activity links open the relevant provider site.

## 5. Data Retention & Disconnection
You can revoke access in Garmin Connect or Strava's connected-application settings. Signing out of this Application does not revoke provider consent. The current Application does not expose an in-app Garmin disconnection or account-deletion workflow.

When the worker confirms Garmin revocation, it marks that connection inactive and removes its current encrypted credentials. Stored health records are not automatically erased by this event. Contact the operator privately for data deletion; do not include health data in a public issue. Workouts and health records are retained until removed by the operator or a future explicit retention/deletion workflow. Backups may retain earlier versions under the configured AWS backup policy.

Encrypted temporary Garmin delivery payloads expire after seven days. Failure metadata is retained up to fourteen days, and function logs have fourteen-day retention. Logs are not intended to contain health payloads or tokens. Medical payloads are compressed and envelope-encrypted before storage, in addition to database encryption at rest.

## 6. Contact Us
For any questions regarding this Privacy Policy, please contact the developer via GitHub.
