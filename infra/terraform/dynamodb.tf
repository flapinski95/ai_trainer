resource "aws_kms_key" "dynamodb" {
  description             = "Encryption key for ${local.resource_prefix} DynamoDB table"
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_key_deletion_window_in_days

  tags = {
    Name        = "${local.resource_prefix}-dynamodb"
    Environment = var.environment
    Project     = var.name_prefix
  }
}

resource "aws_kms_alias" "dynamodb" {
  name          = "alias/${local.resource_prefix}-dynamodb"
  target_key_id = aws_kms_key.dynamodb.key_id
}

resource "aws_dynamodb_table" "app" {
  name                        = "${local.resource_prefix}-app"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.dynamodb_deletion_protection_enabled

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "KEYS_ONLY"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.dynamodb.arn
  }

  tags = {
    Name        = "${local.resource_prefix}-app"
    Environment = var.environment
    Project     = var.name_prefix
  }
}