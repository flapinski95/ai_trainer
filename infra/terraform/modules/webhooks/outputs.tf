output "api_endpoint" {
  value = aws_apigatewayv2_api.webhooks.api_endpoint
}

output "garmin_callback_paths" {
  value = { for category, route in aws_apigatewayv2_route.garmin_callbacks : category => trimprefix(route.route_key, "POST ") }
}