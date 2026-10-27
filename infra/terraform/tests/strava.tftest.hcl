mock_provider "aws" {
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:eu-north-1:123456789012:rule/strava-resume" }
  }
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn        = "arn:aws:dynamodb:eu-north-1:123456789012:table/ai-trainer-dev-app"
      stream_arn = "arn:aws:dynamodb:eu-north-1:123456789012:table/ai-trainer-dev-app/stream/2026-10-25T00:00:00.000"
    }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:ai-trainer/dev/strava-oauth-AbCdEf" }
  }

  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:eu-north-1:123456789012:worker-failures" }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/strava-webhook"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/strava-webhook"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:eu-north-1:123456789012:function:strava-webhook"
    }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:eu-north-1:123456789012:testapi"
      api_endpoint  = "https://testapi.execute-api.eu-north-1.amazonaws.com"
    }
  }
}
mock_provider "archive" {}

variables {
  aws_region                       = "eu-north-1"
  enable_strava_webhook            = false
  strava_verify_token              = null
  strava_subscription_id           = null
  webhook_lambda_arns              = null
  enable_strava_worker             = false
  strava_worker_processing_enabled = false
  enable_garmin_integration        = false
  garmin_processing_enabled        = false
  garmin_webhook_token             = null
  enable_web_push                  = false
  web_push_processing_enabled      = false
  web_push_endpoint                = null
}

run "disabled_by_default" {
  command = plan

  assert {
    condition     = length(aws_lambda_function.strava_webhook) == 0 && length(module.webhooks) == 0 && length(aws_lambda_function.strava_worker) == 0 && length(aws_lambda_function.push_worker) == 0
    error_message = "The default configuration must not deploy webhook infrastructure."
  }

  assert {
    condition     = output.garmin_webhook_url == null && output.garmin_webhook_urls == null && output.health_check_url == null
    error_message = "Disabled integrations must not advertise callback or nonexistent health-check URLs."
  }
}

run "strava_without_garmin" {
  command = plan

  variables {
    enable_strava_webhook = true
    strava_verify_token   = "test-only-verification-token-at-least-32-chars"
  }

  assert {
    condition     = length(aws_lambda_function.strava_webhook) == 1 && length(module.webhooks) == 1
    error_message = "Strava must be deployable without external Lambda ARNs."
  }

  assert {
    condition     = aws_lambda_function.strava_webhook[0].timeout == 30 && aws_lambda_function.strava_webhook[0].runtime == "nodejs22.x"
    error_message = "The Lambda must use the expected runtime and timeout."
  }

  assert {
    condition     = aws_cloudwatch_log_group.strava_webhook[0].retention_in_days == 14
    error_message = "Function logs must have bounded retention."
  }

  assert {
    condition     = aws_lambda_function.strava_webhook[0].environment[0].variables["DYNAMODB_TABLE_NAME"] == module.dynamodb.table_name && aws_lambda_function.strava_webhook[0].environment[0].variables["STRAVA_SUBSCRIPTION_ID"] == ""
    error_message = "The Lambda must target the app table and leave POST disabled until a subscription is configured."
  }
}

run "missing_token_is_rejected" {
  command = plan

  variables {
    enable_strava_webhook = true
  }

  expect_failures = [aws_lambda_function.strava_webhook[0]]
}

run "short_token_is_rejected" {
  command = plan

  variables {
    enable_strava_webhook = true
    strava_verify_token   = "short"
  }

  expect_failures = [var.strava_verify_token]
}

run "external_strava_without_garmin" {
  command = plan

  variables {
    webhook_lambda_arns = {
      strava = "arn:aws:lambda:eu-north-1:123456789012:function:test-strava"
    }
  }

  assert {
    condition     = length(aws_lambda_function.strava_webhook) == 0 && length(module.webhooks) == 1
    error_message = "External Strava must not require Garmin or create a managed Lambda."
  }
}

run "ingestion_permissions" {
  command = apply

  variables {
    enable_strava_webhook  = true
    strava_verify_token    = "test-only-verification-token-at-least-32-chars"
    strava_subscription_id = 789
  }

  assert {
    condition     = aws_lambda_function.strava_webhook[0].environment[0].variables["STRAVA_SUBSCRIPTION_ID"] == "789"
    error_message = "The configured subscription must reach the Lambda."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.strava_webhook_events[0].policy).Statement[0].Action == ["dynamodb:PutItem"] &&
      jsondecode(aws_iam_role_policy.strava_webhook_events[0].policy).Statement[0].Resource == module.dynamodb.table_arn &&
      jsondecode(aws_iam_role_policy.strava_webhook_events[0].policy).Statement[0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["STRAVA#ATHLETE#*"]
    )
    error_message = "DynamoDB permissions must only allow PutItem on Strava partitions in the app table."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.strava_webhook_events[0].policy).Statement[1].Resource == module.dynamodb.kms_key_arn &&
      jsondecode(aws_iam_role_policy.strava_webhook_events[0].policy).Statement[1].Condition.StringEquals["kms:ViaService"] == "dynamodb.eu-north-1.amazonaws.com"
    )
    error_message = "KMS permissions must target the table's key and only permit use through DynamoDB."
  }
}

run "invalid_subscription_is_rejected" {
  command = plan

  variables {
    strava_subscription_id = -1
  }

  expect_failures = [var.strava_subscription_id]
}

run "worker_provisioned_but_paused" {
  command = apply

  variables {
    enable_strava_worker   = true
    strava_subscription_id = 789
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.strava_worker[0].enabled == false &&
      aws_cloudwatch_event_rule.strava_sync[0].state == "DISABLED" &&
      aws_lambda_function.strava_worker[0].timeout == 30 &&
      aws_lambda_function.strava_worker[0].reserved_concurrent_executions == 1 &&
      aws_lambda_event_source_mapping.strava_worker[0].function_response_types == toset(["ReportBatchItemFailures"])
    )
    error_message = "The worker must be paused until credentials are configured, with bounded concurrency and partial-batch retries."
  }

  assert {
    condition = (
      aws_sqs_queue.strava_worker_failures[0].sqs_managed_sse_enabled &&
      aws_sqs_queue.strava_worker_failures[0].message_retention_seconds == 1209600 &&
      aws_secretsmanager_secret.strava_oauth[0].kms_key_id == module.dynamodb.kms_key_arn
    )
    error_message = "Failure metadata and application credentials must be encrypted."
  }

  assert {
    condition = (
      anytrue([for statement in jsondecode(aws_iam_role_policy.strava_worker[0].policy).Statement :
        contains(statement.Action, "secretsmanager:GetSecretValue") && statement.Resource == aws_secretsmanager_secret.strava_oauth[0].arn
      ]) &&
      aws_lambda_function.strava_worker[0].environment[0].variables["STRAVA_OAUTH_SECRET_ARN"] == aws_secretsmanager_secret.strava_oauth[0].arn
    )
    error_message = "The worker may read only its own application secret and receive only the secret ARN."
  }
}

run "worker_processing_enabled" {
  command = plan

  variables {
    enable_strava_worker             = true
    strava_worker_processing_enabled = true
    strava_subscription_id           = 789
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.strava_worker[0].enabled &&
      aws_cloudwatch_event_rule.strava_sync[0].state == "ENABLED" &&
      aws_cloudwatch_event_rule.strava_sync[0].schedule_expression == "rate(1 minute)" &&
      aws_lambda_event_source_mapping.strava_worker[0].batch_size == 1 &&
      aws_lambda_event_source_mapping.strava_worker[0].maximum_retry_attempts == 10 &&
      aws_lambda_event_source_mapping.strava_worker[0].starting_position == "LATEST"
    )
    error_message = "The active worker must consume new events with bounded retries."
  }
}

run "worker_requires_subscription" {
  command = plan

  variables { enable_strava_worker = true }
  expect_failures = [aws_lambda_function.strava_worker[0]]
}

run "garmin_only_without_strava" {
  command = apply

  variables {
    enable_garmin_integration = true
    garmin_webhook_token      = "test-only-garmin-webhook-token-at-least-43-characters"
  }

  assert {
    condition = (
      length(aws_lambda_function.strava_webhook) == 0 &&
      length(aws_lambda_function.garmin_ingress) == 1 &&
      length(aws_lambda_function.garmin_worker) == 1 &&
      aws_lambda_function.garmin_ingress[0].function_name == "ai-trainer-dev-garmin-webhook" &&
      aws_lambda_function.garmin_worker[0].function_name == "ai-trainer-dev-garmin-worker" &&
      aws_lambda_event_source_mapping.garmin[0].enabled == false &&
      aws_lambda_function.garmin_worker[0].timeout == 30 &&
      output.strava_webhook_url == null
    )
    error_message = "Garmin must deploy independently with processing paused and no Strava endpoint."
  }

  assert {
    condition     = output.garmin_webhook_url == "https://testapi.execute-api.eu-north-1.amazonaws.com/api/webhooks/garmin/activities/${var.garmin_webhook_token}" && output.health_check_url == null
    error_message = "The Garmin callback must include the default AWS host, secret token and activity category without inventing a health check."
  }

  assert {
    condition = tomap(output.garmin_webhook_urls) == tomap({
      for category in ["dailies", "sleeps", "activities"] : category => "https://testapi.execute-api.eu-north-1.amazonaws.com/api/webhooks/garmin/${category}/${var.garmin_webhook_token}"
    })
    error_message = "All three Garmin callback routes must expose their exact token-bearing URLs."
  }

  assert {
    condition = (
      aws_secretsmanager_secret.garmin_oauth[0].kms_key_id == module.dynamodb.kms_key_arn &&
      aws_sqs_queue.garmin_failures[0].sqs_managed_sse_enabled &&
      aws_lambda_function.garmin_ingress[0].environment[0].variables["GARMIN_WEBHOOK_SECRET"] == var.garmin_webhook_token &&
      aws_lambda_function.garmin_ingress[0].environment[0].variables["GARMIN_WEBHOOK_TOKEN"] == var.garmin_webhook_token
    )
    error_message = "Garmin ingress and secrets must use the configured protected storage."
  }
}

run "garmin_processing_enabled" {
  command = plan
  variables {
    enable_garmin_integration = true
    garmin_processing_enabled = true
    garmin_webhook_token      = "test-only-garmin-webhook-token-at-least-43-characters"
  }
  assert {
    condition     = aws_lambda_event_source_mapping.garmin[0].enabled && aws_lambda_event_source_mapping.garmin[0].function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "Garmin processing must explicitly opt in and retain partial-batch retry support."
  }
}

run "garmin_requires_separate_webhook_secret" {
  command = plan
  variables { enable_garmin_integration = true }
  expect_failures = [aws_lambda_function.garmin_ingress[0]]
}

run "push_provisioned_but_paused" {
  command = apply
  variables {
    enable_strava_worker   = true
    strava_subscription_id = 789
    enable_web_push        = true
    web_push_endpoint      = "https://trainer.example.com/api/push/workout"
  }
  assert {
    condition = (
      !aws_lambda_event_source_mapping.push_worker[0].enabled &&
      aws_lambda_function.strava_worker[0].environment[0].variables["WEB_PUSH_ENABLED"] == "false" &&
      aws_lambda_function.push_worker[0].runtime == "nodejs22.x" &&
      aws_lambda_function.push_worker[0].timeout == 60 &&
      aws_lambda_function.push_worker[0].reserved_concurrent_executions == 1 &&
      aws_sqs_queue.push_worker_failures[0].sqs_managed_sse_enabled
    )
    error_message = "Push must remain paused with bounded concurrency and encrypted failures until explicitly activated."
  }
  assert {
    condition = (
      aws_secretsmanager_secret.web_push[0].kms_key_id == module.dynamodb.kms_key_arn &&
      aws_lambda_function.push_worker[0].environment[0].variables["WEB_PUSH_SECRET_ARN"] == aws_secretsmanager_secret.web_push[0].arn &&
      !contains(keys(aws_lambda_function.push_worker[0].environment[0].variables), "WEB_PUSH_TRIGGER_SECRET") &&
      anytrue([for statement in jsondecode(aws_iam_role_policy.push_worker[0].policy).Statement :
        contains(statement.Action, "secretsmanager:GetSecretValue") && statement.Resource == aws_secretsmanager_secret.web_push[0].arn
      ])
    )
    error_message = "The Push secret must stay in KMS-backed Secrets Manager with access restricted to its own ARN."
  }
}

run "push_processing_enabled" {
  command = plan
  variables {
    enable_garmin_integration   = true
    garmin_webhook_token        = "test-only-garmin-webhook-token-at-least-43-characters"
    enable_web_push             = true
    web_push_processing_enabled = true
    web_push_endpoint           = "https://trainer.example.com/api/push/workout"
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.push_worker[0].enabled &&
      aws_lambda_event_source_mapping.push_worker[0].batch_size == 1 &&
      aws_lambda_event_source_mapping.push_worker[0].maximum_retry_attempts == 10 &&
      aws_lambda_event_source_mapping.push_worker[0].maximum_record_age_in_seconds == 86400 &&
      aws_lambda_event_source_mapping.push_worker[0].function_response_types == toset(["ReportBatchItemFailures"]) &&
      aws_lambda_function.garmin_worker[0].environment[0].variables["WEB_PUSH_ENABLED"] == "true"
    )
    error_message = "Push must support Garmin-only deployments with explicit activation and bounded partial-batch retries."
  }
}

run "push_rejects_local_endpoint" {
  command = plan
  variables { web_push_endpoint = "http://localhost:3000/api/push/workout" }
  expect_failures = [var.web_push_endpoint]
}

run "push_requires_public_endpoint" {
  command = plan
  variables {
    enable_strava_worker   = true
    strava_subscription_id = 789
    enable_web_push        = true
  }
  expect_failures = [aws_lambda_function.push_worker[0]]
}