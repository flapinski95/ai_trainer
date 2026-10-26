locals {
  strava_worker_name = "${var.name_prefix}-${var.environment}-strava-worker"
}

data "archive_file" "strava_worker" {
  count       = var.enable_strava_worker ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/../../dist/strava-worker/index.js"
  output_path = "${path.module}/.terraform/strava-worker.zip"
}

resource "aws_secretsmanager_secret" "strava_oauth" {
  count                   = var.enable_strava_worker ? 1 : 0
  name                    = "${var.name_prefix}/${var.environment}/strava-oauth"
  description             = "Strava application credentials; populate client_id and client_secret outside Terraform."
  kms_key_id              = module.dynamodb.kms_key_arn
  recovery_window_in_days = 7
}

resource "aws_sqs_queue" "strava_worker_failures" {
  count                     = var.enable_strava_worker ? 1 : 0
  name                      = "${local.strava_worker_name}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_cloudwatch_log_group" "strava_worker" {
  count             = var.enable_strava_worker ? 1 : 0
  name              = "/aws/lambda/${local.strava_worker_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "strava_worker" {
  count = var.enable_strava_worker ? 1 : 0
  name  = "${local.strava_worker_name}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "strava_worker" {
  count = var.enable_strava_worker ? 1 : 0
  name  = "process-strava-events"
  role  = aws_iam_role.strava_worker[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.strava_worker[0].arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
        Resource = module.dynamodb.stream_arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:ListStreams"]
        Resource = "*"
      },
      {
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"]
        Resource  = module.dynamodb.table_arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*", "STRAVA#ATHLETE#*", "STRAVA#RATE_LIMIT"] } }
      },
      {
        Effect    = "Allow"
        Action    = ["dynamodb:Query"]
        Resource  = "${module.dynamodb.table_arn}/index/GSI1"
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["STRAVA#*"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt"]
        Resource = module.dynamodb.kms_key_arn
        Condition = {
          StringEquals = { "kms:EncryptionContext:provider" = "strava" }
          StringLike   = { "kms:EncryptionContext:userId" = "*" }
        }
      },
      {
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = module.dynamodb.kms_key_arn
        Condition = { StringEquals = { "kms:ViaService" = "dynamodb.${var.aws_region}.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.strava_oauth[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = module.dynamodb.kms_key_arn
        Condition = { StringEquals = {
          "kms:ViaService"                  = "secretsmanager.${var.aws_region}.amazonaws.com"
          "kms:EncryptionContext:SecretARN" = aws_secretsmanager_secret.strava_oauth[0].arn
        } }
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.strava_worker_failures[0].arn
      }
    ]
  })
}

resource "aws_lambda_function" "strava_worker" {
  count                          = var.enable_strava_worker ? 1 : 0
  function_name                  = local.strava_worker_name
  role                           = aws_iam_role.strava_worker[0].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = data.archive_file.strava_worker[0].output_path
  source_code_hash               = data.archive_file.strava_worker[0].output_base64sha256
  timeout                        = 30
  memory_size                    = 256
  reserved_concurrent_executions = 1

  environment {
    variables = {
      DYNAMODB_TABLE_NAME     = module.dynamodb.table_name
      DYNAMODB_KMS_KEY_ARN    = module.dynamodb.kms_key_arn
      STRAVA_OAUTH_SECRET_ARN = aws_secretsmanager_secret.strava_oauth[0].arn
      STRAVA_SUBSCRIPTION_ID  = var.strava_subscription_id == null ? "" : tostring(var.strava_subscription_id)
      WEB_PUSH_ENABLED        = tostring(var.enable_web_push && var.web_push_processing_enabled)
    }
  }

  lifecycle {
    precondition {
      condition     = var.strava_subscription_id != null
      error_message = "Set the registered Strava subscription ID before provisioning the worker."
    }
  }

  tags       = { Environment = var.environment, Project = var.name_prefix }
  depends_on = [aws_iam_role_policy.strava_worker]
}

resource "aws_lambda_event_source_mapping" "strava_worker" {
  count                         = var.enable_strava_worker ? 1 : 0
  event_source_arn              = module.dynamodb.stream_arn
  function_name                 = aws_lambda_function.strava_worker[0].arn
  enabled                       = var.strava_worker_processing_enabled
  starting_position             = "LATEST"
  batch_size                    = 1
  parallelization_factor        = 1
  maximum_retry_attempts        = 10
  maximum_record_age_in_seconds = 86400
  function_response_types       = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { NewImage = {
        entityType = { S = ["STRAVA_WEBHOOK_EVENT"] }
        status     = { S = ["RECEIVED"] }
      } } })
    }
    filter {
      pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { NewImage = {
        entityType = { S = ["STRAVA_SYNC_JOB"] }
        state      = { S = ["QUEUED"] }
      } } })
    }
  }

  destination_config {
    on_failure { destination_arn = aws_sqs_queue.strava_worker_failures[0].arn }
  }
}

resource "aws_cloudwatch_event_rule" "strava_sync" {
  count               = var.enable_strava_worker ? 1 : 0
  name                = "${local.strava_worker_name}-resume"
  description         = "Resume due history jobs and deferred webhooks without a separate queue or S3."
  schedule_expression = "rate(1 minute)"
  state               = var.strava_worker_processing_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_lambda_permission" "strava_sync_schedule" {
  count         = var.enable_strava_worker ? 1 : 0
  statement_id  = "AllowStravaResumeSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.strava_worker[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.strava_sync[0].arn
}

resource "aws_cloudwatch_event_target" "strava_sync" {
  count     = var.enable_strava_worker ? 1 : 0
  rule      = aws_cloudwatch_event_rule.strava_sync[0].name
  target_id = "strava-worker"
  arn       = aws_lambda_function.strava_worker[0].arn
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
  depends_on = [aws_lambda_permission.strava_sync_schedule]
}