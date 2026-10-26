locals {
  strava_function_name = "${var.name_prefix}-${var.environment}-strava-webhook"
}

data "archive_file" "strava_webhook" {
  count       = var.enable_strava_webhook ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/../../dist/strava-webhook/index.js"
  output_path = "${path.module}/.terraform/strava-webhook.zip"
}

resource "aws_cloudwatch_log_group" "strava_webhook" {
  count             = var.enable_strava_webhook ? 1 : 0
  name              = "/aws/lambda/${local.strava_function_name}"
  retention_in_days = 14

  tags = {
    Environment = var.environment
    Project     = var.name_prefix
  }
}

resource "aws_iam_role" "strava_webhook" {
  count = var.enable_strava_webhook ? 1 : 0
  name  = "${local.strava_function_name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Environment = var.environment
    Project     = var.name_prefix
  }
}

resource "aws_iam_role_policy" "strava_webhook_logs" {
  count = var.enable_strava_webhook ? 1 : 0
  name  = "write-function-logs"
  role  = aws_iam_role.strava_webhook[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.strava_webhook[0].arn}:*"
    }]
  })
}

resource "aws_iam_role_policy" "strava_webhook_events" {
  count = var.enable_strava_webhook ? 1 : 0
  name  = "persist-strava-events"
  role  = aws_iam_role.strava_webhook[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = module.dynamodb.table_arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["STRAVA#ATHLETE#*"]
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = module.dynamodb.kms_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "dynamodb.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_lambda_function" "strava_webhook" {
  count            = var.enable_strava_webhook ? 1 : 0
  function_name    = local.strava_function_name
  role             = aws_iam_role.strava_webhook[0].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.strava_webhook[0].output_path
  source_code_hash = data.archive_file.strava_webhook[0].output_base64sha256
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      STRAVA_VERIFY_TOKEN    = var.strava_verify_token
      DYNAMODB_TABLE_NAME    = module.dynamodb.table_name
      STRAVA_SUBSCRIPTION_ID = var.strava_subscription_id == null ? "" : tostring(var.strava_subscription_id)
    }
  }

  lifecycle {
    precondition {
      condition     = var.strava_verify_token != null
      error_message = "Set strava_verify_token before enabling the Strava webhook."
    }
  }

  tags = {
    Environment = var.environment
    Project     = var.name_prefix
  }

  depends_on = [aws_iam_role_policy.strava_webhook_logs, aws_iam_role_policy.strava_webhook_events]
}