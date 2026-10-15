import type { Chat } from "./models";

export const layouts = ["teams", "compact", "comfortable"] as const;
export type SidebarLayout = (typeof layouts)[number];
export function sidebarLayout(value: unknown): SidebarLayout {
  return layouts.includes(value as SidebarLayout)
    ? (value as SidebarLayout)
    : "teams";
}
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length
    ? [...words.slice(0, 2).map((w) => Array.from(w)[0])]
        .join("")
        .toLocaleUpperCase()
    : "?";
}
// Avatars stay local to the webview. No tracking URLs, SVG or authenticated URLs.
export function avatarData(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+={0,2}$/.test(
      value,
    )
    ? value
    : "";
}
export type ChatFilter = "all" | "unread" | "groups";
export function filterChats(
  chats: Chat[],
  query: string,
  filter: ChatFilter,
): Chat[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return chats.filter(
    (c) =>
      (filter !== "unread" || c.unread === true) &&
      (filter !== "groups" || c.kind === "group" || c.kind === "meeting") &&
      terms.every((term) =>
        `${c.title} ${c.preview}`.toLocaleLowerCase().includes(term),
      ),
  );
}
export function chatTime(value: string | undefined, now = new Date()): string {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0)
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7)
    return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export interface SidebarState {
  scope: string;
  profile: string;
  accountLabel: string;
  canSwitchProfile: boolean;
  backend: string;
  chats: Chat[];
  layout: SidebarLayout;
  loading: boolean;
  ready: boolean;
  error: string;
  cached: boolean;
  hasMore: boolean;
  connection: string;
  selected: string;
}
export interface SidebarAction {
  type:
    | "ready"
    | "open"
    | "layout"
    | "newMessage"
    | "refresh"
    | "more"
    | "profile"
    | "connection"
    | "selectAccount"
    | "setup";
  scope: string;
  profile?: string;
  id?: string;
  layout?: SidebarLayout;
}
export function validSidebarAction(
  value: unknown,
  scope: string,
): value is SidebarAction {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.scope !== scope || typeof v.type !== "string") return false;
  if (v.type === "open")
    return (
      typeof v.profile === "string" &&
      typeof v.id === "string" &&
      v.id.length > 0 &&
      v.id.length <= 2048
    );
  if (v.type === "layout") return layouts.includes(v.layout as SidebarLayout);
  return [
    "ready",
    "newMessage",
    "refresh",
    "more",
    "profile",
    "connection",
    "selectAccount",
    "setup",
  ].includes(v.type);
}
