resource "aws_apigatewayv2_api" "webhooks" {
  name          = "${local.resource_prefix}-webhooks"
  protocol_type = "HTTP"

  tags = {
    Environment = var.environment
    Project     = var.name_prefix
  }
}

resource "aws_apigatewayv2_integration" "strava" {
  api_id                 = aws_apigatewayv2_api.webhooks.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = var.strava_webhook_lambda_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_integration" "garmin" {
  api_id                 = aws_apigatewayv2_api.webhooks.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = var.garmin_webhook_lambda_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "strava_verify" {
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "GET /webhooks/strava"
  target    = "integrations/${aws_apigatewayv2_integration.strava.id}"
}

resource "aws_apigatewayv2_route" "strava_events" {
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "POST /webhooks/strava"
  target    = "integrations/${aws_apigatewayv2_integration.strava.id}"
}

resource "aws_apigatewayv2_route" "garmin_events" {
  api_id    = aws_apigatewayv2_api.webhooks.id
  route_key = "POST /webhooks/garmin"
  target    = "integrations/${aws_apigatewayv2_integration.garmin.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhooks.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "strava_webhook" {
  statement_id  = "AllowWebhookApiGatewayStrava"
  action        = "lambda:InvokeFunction"
  function_name = var.strava_webhook_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhooks.execution_arn}/*/*"
}

resource "aws_lambda_permission" "garmin_webhook" {
  statement_id  = "AllowWebhookApiGatewayGarmin"
  action        = "lambda:InvokeFunction"
  function_name = var.garmin_webhook_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhooks.execution_arn}/*/*"
}