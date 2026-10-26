import { CircleUserRound } from "lucide-react";

export function ScreenHeader({
  title,
  accountName,
}: {
  title: string;
  accountName?: string | null;
}) {
  return (
    <header className="topbar">
      <span>{title}</span>
      <div className="account-indicator">
        <CircleUserRound size={19} />
        <span className="account-name">{accountName ?? "Nie zalogowano"}</span>
      </div>
    </header>
  );
}