import { useUIStore } from "@/stores/uiStore";
import { AlertTriangle } from "lucide-react";

export function StartupErrorBanner() {
  const startupErrors = useUIStore((s) => s.startupErrors);

  return startupErrors.map((message) => (
    <div
      key={message}
      role="alert"
      className="flex items-center justify-center gap-2 bg-danger text-white text-xs px-4 py-1.5"
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span>{message}</span>
    </div>
  ));
}
