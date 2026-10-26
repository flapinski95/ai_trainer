module "dynamodb" {
  source = "./modules/dynamodb"

  name_prefix                          = var.name_prefix
  environment                          = var.environment
  dynamodb_deletion_protection_enabled = var.dynamodb_deletion_protection_enabled
  kms_key_deletion_window_in_days      = var.kms_key_deletion_window_in_days
  stream_enabled                       = var.enable_strava_worker || var.enable_garmin_integration
}

module "webhooks" {
  for_each = var.enable_strava_webhook || var.webhook_lambda_arns != null || var.enable_garmin_integration ? { enabled = true } : {}
  source   = "./modules/webhooks"

  name_prefix                = var.name_prefix
  environment                = var.environment
  strava_webhook_lambda_arn  = var.enable_strava_webhook ? aws_lambda_function.strava_webhook[0].arn : try(var.webhook_lambda_arns.strava, null)
  garmin_webhook_lambda_arn  = var.enable_garmin_integration ? aws_lambda_function.garmin_ingress[0].arn : try(var.webhook_lambda_arns.garmin, null)
  garmin_push_routes_enabled = var.enable_garmin_integration
  strava_routes_enabled      = var.enable_strava_webhook || var.webhook_lambda_arns != null
  garmin_routes_enabled      = var.enable_garmin_integration || try(var.webhook_lambda_arns.garmin, null) != null
}

moved {
  from = aws_kms_key.dynamodb
  to   = module.dynamodb.aws_kms_key.dynamodb
}

moved {
  from = aws_kms_alias.dynamodb
  to   = module.dynamodb.aws_kms_alias.dynamodb
}

moved {
  from = aws_dynamodb_table.app
  to   = module.dynamodb.aws_dynamodb_table.app
}

moved {
  from = aws_apigatewayv2_api.webhooks
  to   = module.webhooks["enabled"].aws_apigatewayv2_api.webhooks
}

moved {
  from = aws_apigatewayv2_integration.strava
  to   = module.webhooks["enabled"].aws_apigatewayv2_integration.strava
}

moved {
  from = aws_apigatewayv2_integration.garmin
  to   = module.webhooks["enabled"].aws_apigatewayv2_integration.garmin
}

moved {
  from = aws_apigatewayv2_route.strava_verify
  to   = module.webhooks["enabled"].aws_apigatewayv2_route.strava_verify
}

moved {
  from = aws_apigatewayv2_route.strava_events
  to   = module.webhooks["enabled"].aws_apigatewayv2_route.strava_events
}

moved {
  from = aws_apigatewayv2_route.garmin_events
  to   = module.webhooks["enabled"].aws_apigatewayv2_route.garmin_events
}

moved {
  from = aws_apigatewayv2_stage.default
  to   = module.webhooks["enabled"].aws_apigatewayv2_stage.default
}

moved {
  from = aws_lambda_permission.strava_webhook
  to   = module.webhooks["enabled"].aws_lambda_permission.strava_webhook
}

moved {
  from = aws_lambda_permission.garmin_webhook
  to   = module.webhooks["enabled"].aws_lambda_permission.garmin_webhook
}