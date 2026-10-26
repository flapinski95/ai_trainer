variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "dynamodb_deletion_protection_enabled" {
  type = bool
}

variable "kms_key_deletion_window_in_days" {
  type = number
}

variable "stream_enabled" {
  type    = bool
  default = false
}