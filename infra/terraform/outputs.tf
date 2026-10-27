output "dynamodb_table_name" {
  description = "Name of the application single-table DynamoDB table."
  value       = module.dynamodb.table_name
}

output "dynamodb_table_arn" {
  description = "ARN of the application single-table DynamoDB table."
  value       = module.dynamodb.table_arn
}

output "dynamodb_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used by DynamoDB."
  value       = module.dynamodb.kms_key_arn
}

output "webhooks_api_endpoint" {
  description = "Base URL for Strava and Garmin webhook routes."
  value       = try(module.webhooks["enabled"].api_endpoint, null)
}

output "strava_webhook_url" {
  description = "Callback URL used to verify the Strava webhook subscription."
  value       = var.enable_strava_webhook || var.webhook_lambda_arns != null ? try("${module.webhooks["enabled"].api_endpoint}/webhooks/strava", null) : null
}

output "garmin_push_base_url" {
  description = "Secret-bearing base URL. Append /activity, /health, /womens-health, /permissions or /deregistration only in Garmin's endpoint tools."
  sensitive   = true
  value       = var.enable_garmin_integration && var.garmin_webhook_token != null ? "${module.webhooks["enabled"].api_endpoint}/webhooks/garmin/${var.garmin_webhook_token}" : null
}

output "garmin_webhook_url" {
  description = "Garmin activity callback URL, including the secret token for managed PUSH ingestion. Use garmin_push_base_url for other categories."
  sensitive   = true
  value       = var.enable_garmin_integration ? (var.garmin_webhook_token != null ? "${module.webhooks["enabled"].api_endpoint}/api/webhooks/garmin/activities/${var.garmin_webhook_token}" : null) : (try(var.webhook_lambda_arns.garmin, null) != null ? "${module.webhooks["enabled"].api_endpoint}/webhooks/garmin" : null)
}

output "garmin_webhook_urls" {
  description = "Secret-bearing Garmin dailies, sleeps and activities callback URLs."
  sensitive   = true
  value       = var.enable_garmin_integration && var.garmin_webhook_token != null ? { for category, path in module.webhooks["enabled"].garmin_callback_paths : category => "${module.webhooks["enabled"].api_endpoint}${replace(path, "{token}", var.garmin_webhook_token)}" } : null
}

output "health_check_url" {
  description = "No health-check handler is deployed by this Terraform configuration. Garmin's /health category receives health data and is not a service health check."
  value       = null
}

output "garmin_oauth_secret_arn" {
  value = try(aws_secretsmanager_secret.garmin_oauth[0].arn, null)
}

output "strava_oauth_secret_arn" {
  description = "Populate this Secrets Manager secret with client_id and client_secret outside Terraform."
  value       = try(aws_secretsmanager_secret.strava_oauth[0].arn, null)
}

output "strava_worker_function_name" {
  value = try(aws_lambda_function.strava_worker[0].function_name, null)
}

output "strava_worker_failure_queue_url" {
  value = try(aws_sqs_queue.strava_worker_failures[0].url, null)
}

output "web_push_secret_arn" {
  description = "Populate web_push_trigger_secret outside Terraform with the app WEB_PUSH_TRIGGER_SECRET."
  value       = try(aws_secretsmanager_secret.web_push[0].arn, null)
}

output "push_worker_function_name" {
  value = try(aws_lambda_function.push_worker[0].function_name, null)
}

output "push_worker_failure_queue_url" {
  value = try(aws_sqs_queue.push_worker_failures[0].url, null)
}