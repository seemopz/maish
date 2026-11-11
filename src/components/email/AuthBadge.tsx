import { useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from "lucide-react";
import type { AuthResult } from "@/services/gmail/authParser";

interface AuthBadgeProps {
  authResults: string | null;
}

export function AuthBadge({ authResults }: AuthBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  if (!authResults) return null;

  let parsed: AuthResult | null;
  try {
    parsed = JSON.parse(authResults) as AuthResult | null;
  } catch {
    return null;
  }
  // Valid JSON is not necessarily an AuthResult (e.g. a stored "null").
  if (!parsed?.spf || !parsed.dkim || !parsed.dmarc) return null;

  const { aggregate, spf, dkim, dmarc } = parsed;

  const tooltipLines = [
    `SPF: ${spf.result}${spf.detail ? ` (${spf.detail})` : ""}`,
    `DKIM: ${dkim.result}${dkim.detail ? ` (${dkim.detail})` : ""}`,
    `DMARC: ${dmarc.result}${dmarc.detail ? ` (${dmarc.detail})` : ""}`,
  ].join("\n");

  const iconProps = { size: 14, className: "shrink-0" };

  let icon: React.ReactNode;
  let colorClass: string;
  let label: string;

  switch (aggregate) {
    case "pass":
      icon = <ShieldCheck {...iconProps} />;
      colorClass = "text-success";
      label = "Authentication passed";
      break;
    case "warning":
      icon = <ShieldAlert {...iconProps} />;
      colorClass = "text-warning";
      label = "Authentication warning";
      break;
    case "fail":
      icon = <ShieldX {...iconProps} />;
      colorClass = "text-danger";
      label = "Authentication failed";
      break;
    default:
      icon = <ShieldQuestion {...iconProps} />;
      colorClass = "text-text-tertiary";
      label = "Authentication unknown";
      break;
  }

  return (
    <span
      className={`relative inline-flex items-center ${colorClass}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      aria-label={label}
      role="img"
    >
      {icon}
      {showTooltip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-2 font-mono text-[11px] leading-4 font-normal rounded-md bg-bg-primary text-text-secondary border border-border-primary shadow-lg whitespace-pre z-50 pointer-events-none">
          {tooltipLines}
        </span>
      )}
    </span>
  );
}
