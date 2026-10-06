import { useUIStore } from "@/stores/uiStore";
import { WifiOff } from "lucide-react";

export function OfflineBanner() {
  const isOnline = useUIStore((s) => s.isOnline);

  if (isOnline) return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-warning text-white text-xs px-4 py-1.5">
      <WifiOff size={14} />
      <span>You're offline — changes will sync when you reconnect</span>
    </div>
  );
}
