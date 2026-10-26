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