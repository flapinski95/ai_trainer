variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "strava_webhook_lambda_arn" {
  type    = string
  default = null
}

variable "garmin_push_routes_enabled" {
  type    = bool
  default = false
}

variable "strava_routes_enabled" {
  type    = bool
  default = true
}

variable "garmin_routes_enabled" {
  type    = bool
  default = false
}

variable "garmin_webhook_lambda_arn" {
  type    = string
  default = null
}