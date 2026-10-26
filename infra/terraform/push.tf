locals {
  push_worker_name = "${var.name_prefix}-${var.environment}-push-worker"
}

data "archive_file" "push_worker" {
  count       = var.enable_web_push ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/../../dist/push/index.js"
  output_path = "${path.module}/.terraform/push-worker.zip"
}

resource "aws_secretsmanager_secret" "web_push" {
  count                   = var.enable_web_push ? 1 : 0
  name                    = "${var.name_prefix}/${var.environment}/web-push"
  description             = "Populate web_push_trigger_secret outside Terraform with the app WEB_PUSH_TRIGGER_SECRET."
  kms_key_id              = module.dynamodb.kms_key_arn
  recovery_window_in_days = 7
}

resource "aws_sqs_queue" "push_worker_failures" {
  count                     = var.enable_web_push ? 1 : 0
  name                      = "${local.push_worker_name}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_cloudwatch_log_group" "push_worker" {
  count             = var.enable_web_push ? 1 : 0
  name              = "/aws/lambda/${local.push_worker_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "push_worker" {
  count = var.enable_web_push ? 1 : 0
  name  = "${local.push_worker_name}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "push_worker" {
  count = var.enable_web_push ? 1 : 0
  name  = "deliver-workout-push"
  role  = aws_iam_role.push_worker[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.push_worker[0].arn}:*"
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
        Action    = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource  = module.dynamodb.table_arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*"] } }
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
        Resource = aws_secretsmanager_secret.web_push[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = module.dynamodb.kms_key_arn
        Condition = { StringEquals = {
          "kms:ViaService"                  = "secretsmanager.${var.aws_region}.amazonaws.com"
          "kms:EncryptionContext:SecretARN" = aws_secretsmanager_secret.web_push[0].arn
        } }
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.push_worker_failures[0].arn
      }
    ]
  })
}

resource "aws_lambda_function" "push_worker" {
  count                          = var.enable_web_push ? 1 : 0
  function_name                  = local.push_worker_name
  role                           = aws_iam_role.push_worker[0].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = data.archive_file.push_worker[0].output_path
  source_code_hash               = data.archive_file.push_worker[0].output_base64sha256
  timeout                        = 60
  memory_size                    = 256
  reserved_concurrent_executions = 1

  environment {
    variables = {
      DYNAMODB_TABLE_NAME = module.dynamodb.table_name
      WEB_PUSH_ENDPOINT   = var.web_push_endpoint == null ? "" : var.web_push_endpoint
      WEB_PUSH_SECRET_ARN = aws_secretsmanager_secret.web_push[0].arn
    }
  }

  lifecycle {
    precondition {
      condition     = var.web_push_endpoint != null
      error_message = "Set the public HTTPS /api/push/workout endpoint before provisioning Push."
    }
    precondition {
      condition     = var.enable_strava_worker || var.enable_garmin_integration
      error_message = "Enable a managed workout worker before provisioning automatic Push."
    }
  }

  tags       = { Environment = var.environment, Project = var.name_prefix }
  depends_on = [aws_iam_role_policy.push_worker]
}

resource "aws_lambda_event_source_mapping" "push_worker" {
  count                         = var.enable_web_push ? 1 : 0
  event_source_arn              = module.dynamodb.stream_arn
  function_name                 = aws_lambda_function.push_worker[0].arn
  enabled                       = var.web_push_processing_enabled
  starting_position             = "LATEST"
  batch_size                    = 1
  parallelization_factor        = 1
  maximum_retry_attempts        = 10
  maximum_record_age_in_seconds = 86400
  function_response_types       = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { NewImage = {
        entityType = { S = ["PUSH_WORKOUT_JOB"] }
        state      = { S = ["QUEUED"] }
      } } })
    }
  }

  destination_config {
    on_failure { destination_arn = aws_sqs_queue.push_worker_failures[0].arn }
  }
}