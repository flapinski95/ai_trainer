locals {
  garmin_prefix    = "${var.name_prefix}-${var.environment}-garmin"
  garmin_functions = var.enable_garmin_integration ? toset(["ingress", "worker"]) : toset([])
}

data "archive_file" "garmin" {
  for_each    = local.garmin_functions
  type        = "zip"
  source_file = "${path.module}/../../dist/garmin/${each.key}.js"
  output_path = "${path.module}/.terraform/garmin-${each.key}.zip"
}

resource "aws_secretsmanager_secret" "garmin_oauth" {
  count                   = var.enable_garmin_integration ? 1 : 0
  name                    = "${var.name_prefix}/${var.environment}/garmin-oauth"
  description             = "Garmin OAuth client_id/client_secret; populate outside Terraform."
  kms_key_id              = module.dynamodb.kms_key_arn
  recovery_window_in_days = 7
}

resource "aws_sqs_queue" "garmin_failures" {
  count                     = var.enable_garmin_integration ? 1 : 0
  name                      = "${local.garmin_prefix}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_cloudwatch_log_group" "garmin" {
  for_each          = local.garmin_functions
  name              = "/aws/lambda/${local.garmin_prefix}-${each.key}"
  retention_in_days = 14
}

resource "aws_iam_role" "garmin" {
  for_each           = local.garmin_functions
  name               = "${local.garmin_prefix}-${each.key}-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }] })
}

resource "aws_iam_role_policy" "garmin" {
  for_each = local.garmin_functions
  name     = "garmin-${each.key}"
  role     = aws_iam_role.garmin[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.garmin[each.key].arn}:*" },
    { Effect = "Allow", Action = each.key == "ingress" ? ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"] : ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"], Resource = module.dynamodb.table_arn,
    Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = each.key == "ingress" ? ["GARMIN#PUSH#*"] : ["GARMIN#PUSH#*", "USER#*"] } } },
    { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = module.dynamodb.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.${var.aws_region}.amazonaws.com" } } },
    { Effect = "Allow", Action = each.key == "ingress" ? ["kms:GenerateDataKey"] : ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"], Resource = module.dynamodb.kms_key_arn, Condition = { StringEquals = { "kms:EncryptionContext:provider" = "garmin" } } }
    ], [for statement in [
      { Effect = "Allow", Action = ["dynamodb:Query"], Resource = "${module.dynamodb.table_arn}/index/GSI1", Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["GARMIN#*"] } } },
      { Effect = "Allow", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"], Resource = module.dynamodb.stream_arn },
      { Effect = "Allow", Action = ["dynamodb:ListStreams"], Resource = "*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.garmin_oauth[0].arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = module.dynamodb.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com", "kms:EncryptionContext:SecretARN" = aws_secretsmanager_secret.garmin_oauth[0].arn } } },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.garmin_failures[0].arn }
  ] : statement if each.key == "worker"]) })
}

resource "aws_lambda_function" "garmin_ingress" {
  count            = var.enable_garmin_integration ? 1 : 0
  function_name    = "${local.garmin_prefix}-ingress"
  role             = aws_iam_role.garmin["ingress"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "ingress.handler"
  filename         = data.archive_file.garmin["ingress"].output_path
  source_code_hash = data.archive_file.garmin["ingress"].output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = { DYNAMODB_TABLE_NAME = module.dynamodb.table_name, DYNAMODB_KMS_KEY_ARN = module.dynamodb.kms_key_arn, GARMIN_WEBHOOK_TOKEN = var.garmin_webhook_token }
  }
  lifecycle {
    precondition {
      condition     = var.garmin_webhook_token != null
      error_message = "Set a separate random Garmin webhook token before enabling ingestion."
    }
  }
  depends_on = [aws_iam_role_policy.garmin]
}

resource "aws_lambda_function" "garmin_worker" {
  count                          = var.enable_garmin_integration ? 1 : 0
  function_name                  = "${local.garmin_prefix}-worker"
  role                           = aws_iam_role.garmin["worker"].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "worker.handler"
  filename                       = data.archive_file.garmin["worker"].output_path
  source_code_hash               = data.archive_file.garmin["worker"].output_base64sha256
  timeout                        = 30
  memory_size                    = 512
  reserved_concurrent_executions = 1
  environment {
    variables = { DYNAMODB_TABLE_NAME = module.dynamodb.table_name, DYNAMODB_KMS_KEY_ARN = module.dynamodb.kms_key_arn, GARMIN_OAUTH_SECRET_ARN = aws_secretsmanager_secret.garmin_oauth[0].arn }
  }
  depends_on = [aws_iam_role_policy.garmin]
}

resource "aws_lambda_event_source_mapping" "garmin" {
  count                         = var.enable_garmin_integration ? 1 : 0
  event_source_arn              = module.dynamodb.stream_arn
  function_name                 = aws_lambda_function.garmin_worker[0].arn
  enabled                       = var.garmin_processing_enabled
  starting_position             = "LATEST"
  batch_size                    = 1
  maximum_retry_attempts        = -1
  maximum_record_age_in_seconds = 86400
  function_response_types       = ["ReportBatchItemFailures"]
  filter_criteria {
    filter { pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { NewImage = { entityType = { S = ["GARMIN_PUSH"] }, status = { S = ["RECEIVED"] } } } }) }
  }
  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.garmin_failures[0].arn
    }
  }
}