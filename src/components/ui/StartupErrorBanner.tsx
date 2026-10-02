import { useUIStore } from "@/stores/uiStore";
import { AlertTriangle } from "lucide-react";

export function StartupErrorBanner() {
  const startupError = useUIStore((s) => s.startupError);

  if (!startupError) return null;

  return (
    <div
      role="alert"
      className="fixed top-8 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-danger text-white text-xs px-4 py-1.5"
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span>{startupError}</span>
    </div>
  );
}
