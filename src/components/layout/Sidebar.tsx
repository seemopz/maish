import { useEffect, useState, useCallback, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { AccountSwitcher } from "../accounts/AccountSwitcher";
import { LabelForm } from "../labels/LabelForm";
import { InputDialog } from "../ui/InputDialog";
import { SyncIndicator } from "../ui/SyncIndicator";
import { useUIStore } from "@/stores/uiStore";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { useLabelStore, type Label } from "@/stores/labelStore";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { useActiveLabel, useActiveCategory } from "@/hooks/useRouteNavigation";
import { navigateToLabel } from "@/router/navigate";
import {
  Inbox,
  Star,
  Clock,
  Send,
  FileEdit,
  Trash2,
  Ban,
  Mail,
  CheckSquare,
  Calendar,
  Settings,
  Plus,
  PenLine,
  Tag,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Columns2,
  Bell,
  Users,
  Newspaper,
  Search,
  MailOpen,
  Paperclip,
  FolderSearch,
  BookUser,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useTaskStore } from "@/stores/taskStore";

interface SidebarProps {
  collapsed: boolean;
  onAddAccount: () => void;
}

/**
 * "mail" items are mailboxes, "modules" are the separate areas of the app.
 * The sidebar draws a divider wherever the group changes, so the grouping
 * survives the reordering the user can do in Settings.
 */
export type NavGroup = "mail" | "modules";

export const ALL_NAV_ITEMS: { id: string; label: string; icon: LucideIcon; group: NavGroup }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, group: "mail" },
  { id: "starred", label: "Starred", icon: Star, group: "mail" },
  { id: "snoozed", label: "Snoozed", icon: Clock, group: "mail" },
  { id: "sent", label: "Sent", icon: Send, group: "mail" },
  { id: "drafts", label: "Drafts", icon: FileEdit, group: "mail" },
  { id: "trash", label: "Trash", icon: Trash2, group: "mail" },
  { id: "spam", label: "Spam", icon: Ban, group: "mail" },
  { id: "all", label: "All Mail", icon: Mail, group: "mail" },
  { id: "tasks", label: "Tasks", icon: CheckSquare, group: "modules" },
  { id: "calendar", label: "Calendar", icon: Calendar, group: "modules" },
  { id: "contacts", label: "Contacts", icon: BookUser, group: "modules" },
  { id: "attachments", label: "Attachments", icon: Paperclip, group: "modules" },
  { id: "smart-folders", label: "Smart Folders", icon: FolderSearch, group: "mail" },
  { id: "labels", label: "Labels", icon: Tag, group: "mail" },
];

const CATEGORY_ITEMS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "Primary", label: "Primary", icon: Inbox },
  { id: "Updates", label: "Updates", icon: Bell },
  { id: "Promotions", label: "Promotions", icon: Tag },
  { id: "Social", label: "Social", icon: Users },
  { id: "Newsletters", label: "Newsletters", icon: Newspaper },
];

function DroppableNavItem({
  id,
  isActive,
  collapsed,
  onClick,
  onContextMenu,
  title,
  children,
}: {
  id: string;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  children: (isOver: boolean) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      className={`flex items-center w-full h-8 rounded-md text-sm transition-colors ${
        collapsed ? "justify-center px-0" : "gap-2.5 px-2 text-left"
      } ${
        isOver
          ? "bg-bg-selected ring-1 ring-text-tertiary text-text-primary"
          : isActive
            ? "bg-bg-selected text-text-primary font-medium"
            : "text-text-secondary hover:bg-sidebar-hover hover:text-text-primary"
      }`}
    >
      {children(isOver)}
    </button>
  );
}

function DroppableLabelItem({
  label,
  isActive,
  collapsed,
  onClick,
  onContextMenu,
  onEditClick,
}: {
  label: Label;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: label.id });
  const initial = (label.name[0] ?? "?").toUpperCase();

  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={collapsed ? label.name : undefined}
      className={`group flex items-center w-full h-8 rounded-md text-sm transition-colors ${
        collapsed ? "justify-center px-0" : "gap-2.5 px-2 text-left"
      } ${
        isOver
          ? "bg-bg-selected ring-1 ring-text-tertiary text-text-primary"
          : isActive
            ? "bg-bg-selected text-text-primary font-medium"
            : "text-text-secondary hover:bg-sidebar-hover hover:text-text-primary"
      }`}
    >
      {collapsed ? (
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center font-mono text-xs font-medium shrink-0"
          style={label.colorBg
            ? { backgroundColor: label.colorBg, color: label.colorFg ?? "#ffffff" }
            : undefined
          }
        >
          {label.colorBg ? (
            initial
          ) : (
            <Tag size={14} />
          )}
        </span>
      ) : (
        <>
          {label.colorBg ? (
            <span
              className="w-2 h-2 mx-1 rounded-full shrink-0"
              style={{ backgroundColor: label.colorBg }}
            />
          ) : (
            <Tag size={14} className="shrink-0" />
          )}
          <span className="flex-1 truncate">{label.name}</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onEditClick(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onEditClick(); } }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-opacity"
            title="Edit label"
          >
            <Pencil size={12} />
          </span>
        </>
      )}
    </button>
  );
}

const SMART_FOLDER_ICON_MAP: Record<string, LucideIcon> = {
  Search,
  MailOpen,
  Paperclip,
  Star,
  FolderSearch,
  Inbox,
  Clock,
  Tag,
};

function getSmartFolderIcon(iconName: string): LucideIcon {
  return SMART_FOLDER_ICON_MAP[iconName] ?? Search;
}

const LABELS_COLLAPSED_COUNT = 3;

export function Sidebar({ collapsed, onAddAccount }: SidebarProps) {
  const activeLabel = useActiveLabel();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarNavConfig = useUIStore((s) => s.sidebarNavConfig);
  const taskIncompleteCount = useTaskStore((s) => s.incompleteCount);
  const inboxViewMode = useUIStore((s) => s.inboxViewMode);
  const setInboxViewMode = useUIStore((s) => s.setInboxViewMode);
  const activeCategory = useActiveCategory();
  const openComposer = useComposerStore((s) => s.openComposer);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const labels = useLabelStore((s) => s.labels);
  const loadLabels = useLabelStore((s) => s.loadLabels);
  const deleteLabel = useLabelStore((s) => s.deleteLabel);
  const smartFolders = useSmartFolderStore((s) => s.folders);
  const smartFolderCounts = useSmartFolderStore((s) => s.unreadCounts);
  const loadSmartFolders = useSmartFolderStore((s) => s.loadFolders);
  const refreshSmartFolderCounts = useSmartFolderStore((s) => s.refreshUnreadCounts);
  const createSmartFolder = useSmartFolderStore((s) => s.createFolder);
  const SECTION_IDS = new Set(["smart-folders", "labels"]);

  const { visibleNavItems, showSmartFolders, showLabels } = useMemo(() => {
    if (!sidebarNavConfig) {
      const navOnly = ALL_NAV_ITEMS.filter((i) => !SECTION_IDS.has(i.id));
      return { visibleNavItems: navOnly, showSmartFolders: true, showLabels: true };
    }
    const itemMap = new Map(ALL_NAV_ITEMS.map((item) => [item.id, item]));
    const result: typeof ALL_NAV_ITEMS = [];
    const seen = new Set<string>();
    let smartFoldersVisible = true;
    let labelsVisible = true;
    for (const entry of sidebarNavConfig) {
      seen.add(entry.id);
      if (entry.id === "smart-folders") { smartFoldersVisible = entry.visible; continue; }
      if (entry.id === "labels") { labelsVisible = entry.visible; continue; }
      if (entry.visible && itemMap.has(entry.id)) {
        result.push(itemMap.get(entry.id)!);
      }
    }
    // Append any new items not present in the saved config
    for (const item of ALL_NAV_ITEMS) {
      if (!seen.has(item.id) && !SECTION_IDS.has(item.id)) result.push(item);
    }
    return { visibleNavItems: result, showSmartFolders: smartFoldersVisible, showLabels: labelsVisible };
  }, [sidebarNavConfig]);

  const [labelsExpanded, setLabelsExpanded] = useState(false);

  // Inline label editing state
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [showNewLabelForm, setShowNewLabelForm] = useState(false);

  const openMenu = useContextMenuStore((s) => s.openMenu);
  const isSyncingFolder = useUIStore((s) => s.isSyncingFolder);

  const handleNavContextMenu = useCallback((e: React.MouseEvent, navId: string) => {
    e.preventDefault();
    openMenu("sidebarNav", { x: e.clientX, y: e.clientY }, { navId });
  }, [openMenu]);

  // Load labels when active account changes
  useEffect(() => {
    if (activeAccountId) {
      loadLabels(activeAccountId);
    }
  }, [activeAccountId, loadLabels]);

  // Load smart folders when active account changes
  useEffect(() => {
    loadSmartFolders(activeAccountId ?? undefined);
    if (activeAccountId) {
      refreshSmartFolderCounts(activeAccountId);
    }
  }, [activeAccountId, loadSmartFolders, refreshSmartFolderCounts]);

  // Reload labels and smart folder counts on sync completion (debounced to avoid waterfall from multiple emitters)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (activeAccountId) {
          loadLabels(activeAccountId);
          refreshSmartFolderCounts(activeAccountId);
        }
        useUIStore.getState().setSyncingFolder(null);
      }, 500);
    };
    window.addEventListener("maish-sync-done", handler);
    return () => {
      window.removeEventListener("maish-sync-done", handler);
      if (timer) clearTimeout(timer);
    };
  }, [activeAccountId, loadLabels, refreshSmartFolderCounts]);

  const handleDeleteLabel = useCallback(async (labelId: string) => {
    if (!activeAccountId) return;
    try {
      await deleteLabel(activeAccountId, labelId);
      if (editingLabelId === labelId) setEditingLabelId(null);
    } catch {
      // Silently fail in sidebar — user can use Settings for detailed errors
    }
  }, [activeAccountId, deleteLabel, editingLabelId]);

  const handleFormDone = useCallback(() => {
    setEditingLabelId(null);
    setShowNewLabelForm(false);
  }, []);

  const handleEditLabel = useCallback((labelId: string) => {
    setShowNewLabelForm(false);
    setEditingLabelId(labelId);
  }, []);

  const handleLabelContextMenu = useCallback((e: React.MouseEvent, labelId: string) => {
    e.preventDefault();
    openMenu("sidebarLabel", { x: e.clientX, y: e.clientY }, {
      labelId,
      onEdit: () => handleEditLabel(labelId),
      onDelete: () => handleDeleteLabel(labelId),
    });
  }, [openMenu, handleEditLabel, handleDeleteLabel]);

  const handleAddLabel = useCallback(() => {
    setEditingLabelId(null);
    setShowNewLabelForm(true);
  }, []);

  const [showSmartFolderModal, setShowSmartFolderModal] = useState(false);

  const handleAddSmartFolder = useCallback(() => {
    setShowSmartFolderModal(true);
  }, []);

  const editingLabel = editingLabelId ? labels.find((l) => l.id === editingLabelId) ?? null : null;

  return (
    <aside
      className={`no-select flex flex-col bg-sidebar-bg text-sidebar-text border-r border-border-primary transition-all duration-200 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <AccountSwitcher collapsed={collapsed} onAddAccount={onAddAccount} />

      {/* Compose button */}
      <div className="px-3 pt-1 pb-3">
        <button
          onClick={() => openComposer()}
          className="w-full h-8 flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover text-on-accent rounded-md text-sm font-medium interactive-btn"
        >
          {collapsed ? <Plus size={16} /> : (
            <>
              <PenLine size={14} />
              <span>Compose</span>
            </>
          )}
        </button>
      </div>

      <nav className={`flex-1 overflow-y-auto pb-2 space-y-px ${collapsed ? "px-2" : "px-3"}`}>
        {visibleNavItems.map((item, index) => {
          const Icon = item.icon;
          const isInbox = item.id === "inbox";
          const startsNewGroup = index > 0 && item.group !== visibleNavItems[index - 1]?.group;
          return (
            <div key={item.id}>
              {startsNewGroup && (
                <hr className={`my-2 border-border-primary ${collapsed ? "mx-2" : "mx-2"}`} />
              )}
              <DroppableNavItem
                id={item.id}
                isActive={isInbox ? (activeLabel === "inbox" && (inboxViewMode === "unified" || activeCategory === "Primary")) : activeLabel === item.id}
                collapsed={collapsed}
                onClick={() => {
                  if (isInbox && inboxViewMode === "split") {
                    navigateToLabel(item.id, { category: "Primary" });
                  } else {
                    navigateToLabel(item.id);
                  }
                }}
                onContextMenu={(e) => handleNavContextMenu(e, item.id)}
                title={collapsed ? item.label : undefined}
              >
                {() => (
                  <>
                    {isSyncingFolder === item.id ? (
                      <Loader2 size={16} className="shrink-0 animate-spin text-text-tertiary" />
                    ) : (
                      <Icon size={16} className="shrink-0" />
                    )}
                    {!collapsed && (
                      <span className="flex-1 truncate">{item.label}</span>
                    )}
                    {item.id === "tasks" && taskIncompleteCount > 0 && !collapsed && (
                      <span className="font-mono text-[10px] leading-4 tabular-nums text-text-tertiary px-1.5 rounded-full border border-border-primary">
                        {taskIncompleteCount}
                      </span>
                    )}
                    {isInbox && !collapsed && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setInboxViewMode(inboxViewMode === "split" ? "unified" : "split");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            setInboxViewMode(inboxViewMode === "split" ? "unified" : "split");
                          }
                        }}
                        title={inboxViewMode === "split" ? "Switch to unified inbox" : "Switch to split inbox"}
                        className={`p-1 rounded transition-colors ${
                          inboxViewMode === "split"
                            ? "text-text-primary hover:bg-bg-hover"
                            : "text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                        }`}
                      >
                        <Columns2 size={14} />
                      </span>
                    )}
                  </>
                )}
              </DroppableNavItem>
              {/* Category sub-items when split mode is active */}
              {isInbox && inboxViewMode === "split" && !collapsed && (
                <div>
                  {CATEGORY_ITEMS.map((cat) => {
                    const CatIcon = cat.icon;
                    const isCatActive = activeLabel === "inbox" && activeCategory === cat.id;
                    return (
                      <button
                        key={cat.id}
                        onClick={() => {
                          navigateToLabel("inbox", { category: cat.id });
                        }}
                        className={`flex items-center gap-2 w-full h-7 pl-8 pr-2 rounded-md text-left text-[13px] transition-colors ${
                          isCatActive
                            ? "text-text-primary font-medium bg-bg-hover"
                            : "text-text-tertiary hover:text-text-primary hover:bg-sidebar-hover"
                        }`}
                      >
                        <CatIcon size={14} className="shrink-0" />
                        <span className="flex-1 truncate">{cat.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Smart Folders */}
        {showSmartFolders && (smartFolders.length > 0 || !collapsed) && (
          <>
            {!collapsed && (
              <div className="flex items-center justify-between px-2 pt-5 pb-1.5">
                <span className="label-mono">
                  Smart Folders
                </span>
                <button
                  onClick={handleAddSmartFolder}
                  className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  title="Add smart folder"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
            {smartFolders.map((folder) => {
              const Icon = getSmartFolderIcon(folder.icon);
              const isActive = activeLabel === `smart-folder:${folder.id}`;
              const count = smartFolderCounts[folder.id] ?? 0;
              return (
                <button
                  key={folder.id}
                  onClick={() => navigateToLabel(`smart-folder:${folder.id}`)}
                  title={collapsed ? folder.name : undefined}
                  className={`flex items-center w-full h-8 rounded-md text-sm transition-colors ${
                    collapsed ? "justify-center px-0" : "gap-2.5 px-2 text-left"
                  } ${
                    isActive
                      ? "bg-bg-selected text-text-primary font-medium"
                      : "text-text-secondary hover:bg-sidebar-hover hover:text-text-primary"
                  }`}
                >
                  <Icon
                    size={16}
                    className="shrink-0"
                    style={folder.color ? { color: folder.color } : undefined}
                  />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{folder.name}</span>
                      {count > 0 && (
                        <span className="font-mono text-[10px] leading-4 tabular-nums text-text-tertiary px-1.5 rounded-full border border-border-primary">
                          {count}
                        </span>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </>
        )}

        {/* User labels */}
        {showLabels && (labels.length > 0 || !collapsed) && (
          <>
            {!collapsed && (
              <div className="flex items-center justify-between px-2 pt-5 pb-1.5">
                <span className="label-mono">
                  Labels
                </span>
                <button
                  onClick={handleAddLabel}
                  className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  title="Add label"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
            {/* Always-visible labels */}
            {labels.slice(0, LABELS_COLLAPSED_COUNT).map((label) => (
              <div key={label.id}>
                <DroppableLabelItem
                  label={label}
                  isActive={activeLabel === label.id}
                  collapsed={collapsed}
                  onClick={() => navigateToLabel(label.id)}
                  onContextMenu={(e) => handleLabelContextMenu(e, label.id)}
                  onEditClick={() => handleEditLabel(label.id)}
                />
                {editingLabelId === label.id && activeAccountId && !collapsed && (
                  <LabelForm
                    accountId={activeAccountId}
                    label={editingLabel}
                    onDone={handleFormDone}
                    variant="sidebar"
                  />
                )}
              </div>
            ))}
            {/* Collapsible labels with accordion animation */}
            {labels.length > LABELS_COLLAPSED_COUNT && (
              <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${labelsExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                <div className="overflow-hidden">
                  {labels.slice(LABELS_COLLAPSED_COUNT).map((label) => (
                    <div key={label.id}>
                      <DroppableLabelItem
                        label={label}
                        isActive={activeLabel === label.id}
                        collapsed={collapsed}
                        onClick={() => navigateToLabel(label.id)}
                        onContextMenu={(e) => handleLabelContextMenu(e, label.id)}
                        onEditClick={() => handleEditLabel(label.id)}
                      />
                      {editingLabelId === label.id && activeAccountId && !collapsed && (
                        <LabelForm
                          accountId={activeAccountId}
                          label={editingLabel}
                          onDone={handleFormDone}
                          variant="sidebar"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!collapsed && labels.length > LABELS_COLLAPSED_COUNT && (
              <button
                onClick={() => setLabelsExpanded((v) => !v)}
                className="flex items-center gap-2 w-full h-7 px-2 rounded-md font-mono text-[11px] text-text-tertiary hover:text-text-primary hover:bg-sidebar-hover transition-colors"
              >
                {labelsExpanded ? (
                  <>
                    <ChevronUp size={12} />
                    <span>Show less</span>
                  </>
                ) : (
                  <>
                    <ChevronDown size={12} />
                    <span>{labels.length - LABELS_COLLAPSED_COUNT} more</span>
                  </>
                )}
              </button>
            )}
            {/* New label form at bottom of list */}
            {showNewLabelForm && activeAccountId && !collapsed && (
              <LabelForm
                accountId={activeAccountId}
                onDone={handleFormDone}
                variant="sidebar"
              />
            )}
          </>
        )}
      </nav>

      {/* Bottom bar: sync indicator (slot kept even when idle), Settings, Help + collapse toggle */}
      <div className={`py-2 border-t border-border-primary flex ${collapsed ? "flex-col items-center gap-1 px-2" : "items-center gap-0.5 px-3"}`}>
        <SyncIndicator />
        <button
          onClick={() => navigateToLabel("settings")}
          className={`flex items-center text-sm rounded-md transition-colors ${
            collapsed ? "p-2 justify-center" : "gap-2.5 flex-1 h-8 px-2 text-left"
          } ${
            activeLabel === "settings"
              ? "bg-bg-selected text-text-primary font-medium"
              : "text-text-secondary hover:text-text-primary hover:bg-sidebar-hover"
          }`}
          title="Settings"
        >
          <Settings size={16} className="shrink-0" />
          {!collapsed && <span>Settings</span>}
        </button>
        <button
          onClick={() => navigateToLabel("help")}
          className={`flex items-center text-sm rounded-md transition-colors ${
            collapsed ? "p-2 justify-center" : "p-2"
          } ${
            activeLabel === "help"
              ? "bg-bg-selected text-text-primary font-medium"
              : "text-text-tertiary hover:text-text-primary hover:bg-sidebar-hover"
          }`}
          title="Help"
        >
          <HelpCircle size={16} className="shrink-0" />
        </button>
        <button
          onClick={toggleSidebar}
          className="p-2 text-text-tertiary hover:text-text-primary hover:bg-sidebar-hover rounded-md transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <InputDialog
        isOpen={showSmartFolderModal}
        onClose={() => setShowSmartFolderModal(false)}
        onSubmit={(values) => {
          createSmartFolder(
            values.name!.trim(),
            values.query!.trim(),
            activeAccountId ?? undefined,
          );
        }}
        title="New Smart Folder"
        fields={[
          { key: "name", label: "Name", placeholder: "e.g. Unread from boss" },
          { key: "query", label: "Search query", placeholder: "e.g. is:unread from:boss" },
        ]}
      />

      {/* Pending operations indicator */}
      <PendingOpsIndicator collapsed={collapsed} />
    </aside>
  );
}

function PendingOpsIndicator({ collapsed }: { collapsed: boolean }) {
  const pendingOpsCount = useUIStore((s) => s.pendingOpsCount);
  if (pendingOpsCount <= 0) return null;

  return (
    <div className="px-3 py-2 border-t border-border-primary">
      {collapsed ? (
        <div className="flex justify-center">
          <span className="font-mono text-[10px] leading-4 tabular-nums text-text-tertiary px-1.5 rounded-full border border-border-primary">{pendingOpsCount}</span>
        </div>
      ) : (
        <div className="font-mono text-[11px] text-text-tertiary">
          {pendingOpsCount} pending {pendingOpsCount === 1 ? "change" : "changes"}
        </div>
      )}
    </div>
  );
}
