import { ShieldX, X } from "lucide-react";
import type { AuthResult } from "@/services/gmail/authParser";

interface AuthWarningBannerProps {
  authResults: string | null;
  senderAddress: string | null;
  onDismiss: () => void;
}

export function AuthWarningBanner({ authResults, senderAddress, onDismiss }: AuthWarningBannerProps) {
  if (!authResults) return null;

  let parsed: AuthResult | null;
  try {
    parsed = JSON.parse(authResults) as AuthResult | null;
  } catch {
    return null;
  }

  // Valid JSON is not necessarily an AuthResult (e.g. a stored "null").
  if (parsed?.aggregate !== "fail") return null;

  const sender = senderAddress ?? "this sender";

  return (
    <div className="bg-danger/5 border border-danger/30 rounded-md px-3 py-2.5 mb-3 flex items-start gap-2.5">
      <ShieldX size={16} className="text-danger shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-danger font-medium">
          Authentication failed
        </p>
        <p className="text-xs text-text-secondary mt-0.5">
          This message from {sender} failed email authentication checks (SPF/DKIM/DMARC).
          Be cautious with any links or attachments.
        </p>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 p-1 -m-0.5 rounded-md hover:bg-danger/10 text-text-tertiary hover:text-text-primary transition-colors"
        aria-label="Dismiss warning"
      >
        <X size={14} />
      </button>
    </div>
  );
}
