variable "aws_region" {
  description = "AWS region for the infrastructure."
  type        = string
  default     = "eu-north-1"
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

variable "terraform_admin_iam_user" {
  description = "Existing IAM user that receives AdministratorAccess for Terraform management."
  type        = string
  default     = "lapinski-cli"
}

variable "enable_strava_webhook" {
  description = "Deploy the managed Strava verification and event ingestion Lambda and webhook API."
  type        = bool
  default     = false
}

variable "strava_verify_token" {
  description = "Secret verification token supplied when registering the Strava subscription. Stored in Terraform state."
  type        = string
  sensitive   = true
  default     = null

  validation {
    condition     = var.strava_verify_token == null ? true : length(trimspace(var.strava_verify_token)) >= 32
    error_message = "Provide a verification token of at least 32 non-whitespace characters."
  }
}

variable "enable_garmin_integration" {
  description = "Provision Garmin PUSH ingestion, encrypted storage, and its processing worker independently of Strava."
  type        = bool
  default     = false
}

variable "garmin_processing_enabled" {
  description = "Enable Garmin stream processing only after populating its OAuth application secret."
  type        = bool
  default     = false
}

variable "garmin_webhook_token" {
  description = "Random URL-safe secret protecting Garmin PUSH callback URLs. Stored in Terraform state; never log or share callback URLs."
  type        = string
  sensitive   = true
  default     = null
  validation {
    condition     = var.garmin_webhook_token == null ? true : can(regex("^[A-Za-z0-9_-]{43,128}$", var.garmin_webhook_token))
    error_message = "Use at least 43 random URL-safe characters, e.g. openssl rand -hex 32."
  }
}

variable "enable_strava_worker" {
  description = "Provision Strava processing, DynamoDB Streams, a credentials secret container and failure queue."
  type        = bool
  default     = false
}

variable "strava_worker_processing_enabled" {
  description = "Start consuming new stream events only after filling the Strava OAuth secret."
  type        = bool
  default     = false
}

variable "strava_subscription_id" {
  description = "ID returned by Strava when registering the webhook subscription. POST ingestion stays unavailable until configured."
  type        = number
  default     = null

  validation {
    condition = var.strava_subscription_id == null ? true : (
      var.strava_subscription_id > 0 && var.strava_subscription_id <= 9007199254740991 &&
      floor(var.strava_subscription_id) == var.strava_subscription_id
    )
    error_message = "The Strava subscription ID must be a positive safe integer."
  }
}

variable "webhook_lambda_arns" {
  description = "External webhook Lambdas. Garmin is optional; managed Strava takes precedence when enabled."
  type = object({
    strava = string
    garmin = optional(string)
  })
  default  = null
  nullable = true

  validation {
    condition = var.webhook_lambda_arns == null ? true : (
      length(trimspace(var.webhook_lambda_arns.strava)) > 0 &&
      (var.webhook_lambda_arns.garmin == null ? true : length(trimspace(var.webhook_lambda_arns.garmin)) > 0)
    )
    error_message = "Provide a non-empty Strava ARN and, if specified, a non-empty Garmin ARN."
  }
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