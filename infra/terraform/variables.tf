variable "aws_region" {
  description = "AWS region for the infrastructure."
  type        = string
  default     = "eu-central-1"
}

variable "name_prefix" {
  description = "Prefix used for named AWS resources."
  type        = string
  default     = "ai-trainer"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "dev"
}

variable "strava_webhook_lambda_arn" {
  description = "ARN of the Lambda handling Strava webhook verification and events."
  type        = string
}

variable "garmin_webhook_lambda_arn" {
  description = "ARN of the Lambda handling Garmin webhook events."
  type        = string
}

variable "dynamodb_deletion_protection_enabled" {
  description = "Whether deletion protection is enabled for the DynamoDB table."
  type        = bool
  default     = true
}

variable "kms_key_deletion_window_in_days" {
  description = "Waiting period before a scheduled KMS key deletion."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_key_deletion_window_in_days >= 7 && var.kms_key_deletion_window_in_days <= 30
    error_message = "The KMS key deletion window must be between 7 and 30 days."
  }
}