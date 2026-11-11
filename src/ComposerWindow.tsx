import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Composer } from "./components/composer/Composer";
import { UndoSendToast } from "./components/composer/UndoSendToast";
import { useAccountStore } from "./stores/accountStore";
import { useComposerStore } from "./stores/composerStore";
import { useUIStore } from "./stores/uiStore";
import { runMigrations } from "./services/db/migrations";
import { getAllAccounts } from "./services/db/accounts";
import { getSetting } from "./services/db/settings";
import { initializeClients } from "./services/gmail/tokenManager";
import type { ComposerMode } from "./stores/composerStore";

export default function ComposerWindow() {
  const { setTheme, setFontScale } = useUIStore();
  const { setAccounts } = useAccountStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    async function init() {
      try {
        await runMigrations();

        // Restore theme
        const savedTheme = await getSetting("theme");
        if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
          setTheme(savedTheme);
        }

        // Restore font scale
        const savedFontScale = await getSetting("font_size");
        if (savedFontScale === "small" || savedFontScale === "default" || savedFontScale === "large" || savedFontScale === "xlarge") {
          setFontScale(savedFontScale);
        }

        // Load accounts into store
        const dbAccounts = await getAllAccounts();
        const mapped = dbAccounts.map((a) => ({
          id: a.id,
          email: a.email,
          displayName: a.display_name,
          avatarUrl: a.avatar_url,
          isActive: a.is_active === 1,
          provider: a.provider,
        }));
        setAccounts(mapped, params.get("accountId"));

        // Initialize Gmail clients
        await initializeClients();

        // Parse composer state from URL params
        const mode = (params.get("mode") as ComposerMode) ?? "new";
        const to = params.get("to")?.split(",").filter(Boolean) ?? [];
        const cc = params.get("cc")?.split(",").filter(Boolean) ?? [];
        const bcc = params.get("bcc")?.split(",").filter(Boolean) ?? [];
        const subject = params.get("subject") ?? "";
        const threadId = params.get("threadId") ?? null;
        const inReplyToMessageId = params.get("inReplyToMessageId") ?? null;
        const references = params.get("references") ?? null;
        const draftId = params.get("draftId") ?? null;
        const fromEmail = params.get("fromEmail");

        // Decode base64 body
        let bodyHtml = "";
        const bodyParam = params.get("body");
        if (bodyParam) {
          try {
            bodyHtml = decodeURIComponent(escape(atob(bodyParam)));
          } catch {
            bodyHtml = "";
          }
        }

        // Open composer with parsed state
        useComposerStore.getState().openComposer({
          mode,
          to,
          cc,
          bcc,
          subject,
          bodyHtml,
          threadId,
          inReplyToMessageId,
          references,
          draftId,
        });

        // Set fromEmail and force fullpage mode
        if (fromEmail) {
          useComposerStore.getState().setFromEmail(fromEmail);
        }
        useComposerStore.getState().setViewMode("fullpage");
      } catch (err) {
        console.error("Failed to initialize composer window:", err);
        setError("Failed to load composer");
      }
      setLoading(false);
    }

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable references
  }, []);

  // Send closes the composer at once, but the mail leaves only when the undo
  // timer runs out; closing the window before that would kill the timer. So
  // closing is blocked while a send is pending, and the window closes itself
  // once the composer is closed and nothing is left to send.
  useEffect(() => {
    if (loading || error) return;
    const win = getCurrentWindow();
    let closeGuard: Promise<() => void> | null = null;
    const unsubscribe = useComposerStore.subscribe((state) => {
      if (state.pendingSend) {
        closeGuard ??= win.onCloseRequested((e) => e.preventDefault());
        return;
      }
      if (state.isOpen && !closeGuard) return;
      const guard = closeGuard;
      closeGuard = null;
      void (async () => {
        // UnlistenFn is typed void but is an IPC round trip; a close sent before it lands is still blocked.
        if (guard) await (await guard)();
        if (!useComposerStore.getState().isOpen) await win.close();
      })();
    });
    return () => {
      unsubscribe();
      void closeGuard?.then((unlisten) => unlisten());
    };
  }, [loading, error]);

  // Sync theme class to <html>
  const theme = useUIStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else if (theme === "light") {
      root.classList.remove("dark");
    } else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = () => {
        if (mq.matches) root.classList.add("dark");
        else root.classList.remove("dark");
      };
      apply();
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // Sync font-scale class to <html>
  const fontScale = useUIStore((s) => s.fontScale);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("font-scale-small", "font-scale-default", "font-scale-large", "font-scale-xlarge");
    root.classList.add(`font-scale-${fontScale}`);
  }, [fontScale]);


  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary text-text-secondary">
        <span className="text-sm">Loading composer...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary text-text-secondary">
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
      <Composer />
      <UndoSendToast />
    </div>
  );
}
