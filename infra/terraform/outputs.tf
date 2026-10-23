output "dynamodb_table_name" {
  description = "Name of the application single-table DynamoDB table."
  value       = aws_dynamodb_table.app.name
}

output "dynamodb_table_arn" {
  description = "ARN of the application single-table DynamoDB table."
  value       = aws_dynamodb_table.app.arn
}

output "dynamodb_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used by DynamoDB."
  value       = aws_kms_key.dynamodb.arn
}

output "webhooks_api_endpoint" {
  description = "Base URL for Strava and Garmin webhook routes."
  value       = aws_apigatewayv2_api.webhooks.api_endpoint
}