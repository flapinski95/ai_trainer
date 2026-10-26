output "table_name" {
  value = aws_dynamodb_table.app.name
}

output "table_arn" {
  value = aws_dynamodb_table.app.arn
}

output "kms_key_arn" {
  value = aws_kms_key.dynamodb.arn
}

output "stream_arn" {
  value = aws_dynamodb_table.app.stream_arn
}