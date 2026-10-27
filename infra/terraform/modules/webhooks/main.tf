locals {
  resource_prefix = "${var.name_prefix}-${var.environment}"
}

resource "aws_apigatewayv2_api" "webhooks" {
  name          = "${local.resource_prefix}-webhooks"
  protocol_type = "HTTP"

  tags = {
    Environment = var.environment
    Project     = var.name_prefix
  }
}

resource "aws_apigatewayv2_integration" "strava" {
  count                  = var.strava_routes_enabled ? 1 : 0
  api_id                 = aws_apigatewayv2_api.webhooks.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = var.strava_webhook_lambda_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_integration" "garmin" {
  count                  = var.garmin_routes_enabled ? 1 : 0
  api_id                 = aws_apigatewayv2_api.webhooks.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = var.garmin_webhook_lambda_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "strava_verify" {
  count     = var.strava_routes_enabled ? 1 : 0
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "GET /webhooks/strava"
  target    = "integrations/${aws_apigatewayv2_integration.strava[0].id}"
}

resource "aws_apigatewayv2_route" "strava_events" {
  count     = var.strava_routes_enabled ? 1 : 0
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "POST /webhooks/strava"
  target    = "integrations/${aws_apigatewayv2_integration.strava[0].id}"
}

resource "aws_apigatewayv2_route" "garmin_events" {
  count     = var.garmin_routes_enabled ? 1 : 0
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = var.garmin_push_routes_enabled ? "POST /webhooks/garmin/{webhookToken}/{category}" : "POST /webhooks/garmin"
  target    = "integrations/${aws_apigatewayv2_integration.garmin[0].id}"
}

resource "aws_apigatewayv2_route" "garmin_callbacks" {
  for_each  = var.garmin_routes_enabled && var.garmin_push_routes_enabled ? toset(["dailies", "sleeps", "activities"]) : toset([])
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "POST /api/webhooks/garmin/${each.key}/{token}"
  target    = "integrations/${aws_apigatewayv2_integration.garmin[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhooks.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "strava_webhook" {
  count         = var.strava_routes_enabled ? 1 : 0
  statement_id  = "AllowWebhookApiGatewayStrava"
  action        = "lambda:InvokeFunction"
  function_name = var.strava_webhook_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhooks.execution_arn}/*/*/webhooks/strava"
}

resource "aws_lambda_permission" "garmin_webhook" {
  count         = var.garmin_routes_enabled ? 1 : 0
  statement_id  = "AllowWebhookApiGatewayGarmin"
  action        = "lambda:InvokeFunction"
  function_name = var.garmin_webhook_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = var.garmin_push_routes_enabled ? "${aws_apigatewayv2_api.webhooks.execution_arn}/*/POST/webhooks/garmin/*/*" : "${aws_apigatewayv2_api.webhooks.execution_arn}/*/POST/webhooks/garmin"
}

resource "aws_lambda_permission" "garmin_callbacks" {
  for_each      = aws_apigatewayv2_route.garmin_callbacks
  statement_id  = "AllowWebhookApiGatewayGarmin-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = var.garmin_webhook_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhooks.execution_arn}/*/POST/api/webhooks/garmin/${each.key}/*"
}

moved {
  from = aws_apigatewayv2_integration.strava
  to   = aws_apigatewayv2_integration.strava[0]
}

moved {
  from = aws_apigatewayv2_route.strava_verify
  to   = aws_apigatewayv2_route.strava_verify[0]
}

moved {
  from = aws_apigatewayv2_route.strava_events
  to   = aws_apigatewayv2_route.strava_events[0]
}

moved {
  from = aws_lambda_permission.strava_webhook
  to   = aws_lambda_permission.strava_webhook[0]
}

moved {
  from = aws_apigatewayv2_integration.garmin
  to   = aws_apigatewayv2_integration.garmin[0]
}

moved {
  from = aws_apigatewayv2_route.garmin_events
  to   = aws_apigatewayv2_route.garmin_events[0]
}

moved {
  from = aws_lambda_permission.garmin_webhook
  to   = aws_lambda_permission.garmin_webhook[0]
}