resource "aws_iam_user_policy_attachment" "terraform_admin" {
  user       = var.terraform_admin_iam_user
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}