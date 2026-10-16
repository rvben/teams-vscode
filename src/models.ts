import { decodeHTML } from "entities";
import { avatarData } from "./sidebar-model";

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export interface Profile {
  name: string;
  backend: "graph" | "desktop";
  readOnly: boolean;
  active: boolean;
  accountLabel?: string;
}
// A configured account surface is not a verified person or organization.
export function accountLabel(backend: string, config: unknown = {}): string {
  const account = obj(config).desktop_account;
  if (
    backend === "graph" ||
    account === "work_school" ||
    account === "work-school"
  )
    return "Work or school";
  return account === "personal" ? "Personal account" : "Teams account";
}
export interface Chat {
  id: string;
  title: string;
  preview: string;
  kind: string;
  updated?: string;
  unread?: boolean;
  avatar?: string;
  memberAvatars?: { senderId: string; avatar: string }[];
}
export interface Message {
  id: string;
  sender: string;
  senderId?: string;
  avatar?: string;
  text: string;
  time: string;
  clientId: string;
  delivery: string;
}
export interface Page<T> {
  items: T[];
  cursor: string;
  cached: boolean;
}
export function profiles(value: unknown): Profile[] {
  const rows = obj(value).items;
  if (!Array.isArray(rows))
    throw new Error("Invalid profile list from Teams CLI.");
  return rows
    .map(obj)
    .filter((v) => str(v.name))
    .map((v) => ({
      name: str(v.name),
      backend: v.backend === "desktop" ? "desktop" : "graph",
      readOnly: v.read_only === true,
      active: v.active === true,
    }));
}
export function plain(value: unknown, html = false): string {
  const text = str(value);
  if (!html) return text;
  return decodeHTML(
    text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|blockquote|pre|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function chat(v: unknown): Chat {
  const o = obj(v),
    last = obj(o.lastMessagePreview),
    preview = obj(last.body),
    viewpoint = obj(o.viewpoint);
  const members = Array.isArray(o.members)
    ? o.members.map((m) => str(obj(m).displayName)).filter(Boolean)
    : [];
  return {
    id: str(o.id),
    title:
      str(o.topic) ||
      [...new Set(members)].join(", ") ||
      "Untitled conversation",
    preview: (last.isDeleted === true
      ? "Message deleted"
      : last.messageType && last.messageType !== "message"
        ? "Conversation updated"
        : plain(preview.content, preview.contentType === "html")
    )
      .replace(/\s+/g, " ")
      .slice(0, 180),
    kind: str(o.chatType),
    updated: str(last.createdDateTime) || str(o.lastUpdatedDateTime),
    unread:
      typeof o.isUnread === "boolean"
        ? o.isUnread
        : typeof viewpoint.isRead === "boolean"
          ? !viewpoint.isRead
          : Number.isFinite(
                Date.parse(str(viewpoint.lastMessageReadDateTime)),
              ) && Number.isFinite(Date.parse(str(last.createdDateTime)))
            ? Date.parse(str(last.createdDateTime)) >
              Date.parse(str(viewpoint.lastMessageReadDateTime))
            : undefined,
    avatar: avatarData(o.avatarData),
    memberAvatars: Array.isArray(o.members)
      ? o.members.map(obj).flatMap((member) => {
          const id = str(member.userId),
            avatar = avatarData(member.avatarData);
          return id && avatar ? [{ senderId: `user:${id}`, avatar }] : [];
        })
      : [],
  };
}
export function message(v: unknown): Message {
  const o = obj(v),
    body = obj(o.body),
    from = obj(o.from),
    user = obj(from.user);
  return {
    id: str(o.id),
    sender:
      str(user.displayName) ||
      str(obj(from.application).displayName) ||
      "Teams",
    senderId: str(user.id)
      ? `user:${str(user.id)}`
      : str(obj(from.application).id)
        ? `application:${str(obj(from.application).id)}`
        : undefined,
    text:
      plain(body.content, body.contentType === "html") ||
      (o.messageType && o.messageType !== "message"
        ? "System event"
        : "[No text content]"),
    time: str(o.createdDateTime),
    clientId: str(o.clientMessageId),
    delivery: str(o.delivery_state) || str(o.status),
  };
}
export function page<T>(v: unknown, convert: (v: unknown) => T): Page<T> {
  const o = obj(v);
  if (!Array.isArray(o.items))
    throw new Error("Invalid history page from Teams CLI.");
  return {
    items: o.items.map(convert),
    cursor: str(o.next_cursor),
    cached: o.source === "desktop_cache",
  };
}
export function mergeMessages(old: Message[], incoming: Message[]): Message[] {
  const merged = new Map(old.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (m.id) merged.set(m.id, m);
  }
  return [...merged.values()].sort(
    (a, b) =>
      (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0) ||
      a.id.localeCompare(b.id),
  );
}
export function friendly(kind: string): string {
  const messages: Record<string, string> = {
    auth: "Sign in to this profile in Teams or run Teams: Sign In to Graph Profile.",
    read_only:
      "This CLI profile is read-only. Use a profile configured to allow sending.",
    permission_denied:
      "Teams denied access. Check the account and its permissions.",
    rate_limit:
      "Teams is limiting requests. Refresh will resume after a pause.",
    desktop_error:
      "Teams Desktop could not complete this request. Check the connection, then refresh.",
    desktop_account_ambiguous:
      "More than one Teams account is available. Choose Personal or Work or school for this connection.",
    browser_supervision:
      "Automatic browser cleanup could not start. Refresh the connection or check the selected CLI before retrying.",
    desktop_prerequisites:
      "The Teams browser is not ready. Check your browser installation or run Guided Account Setup before retrying.",
    desktop_busy:
      "Another browser connection command is running. Wait a moment and retry.",
    desktop_disconnected:
      "The Teams Desktop connection is closed. Connect again to load messages.",
    desktop_no_window:
      "No Teams window is available. Open Teams and sign in, then refresh.",
    desktop_cache_unsupported:
      "This version of Teams uses a cache layout the CLI does not support yet.",
    not_found:
      "This conversation is no longer available. Refresh the conversation list.",
    confirmation_required:
      "This action needs confirmation. Use the Teams connection commands.",
    unsupported: "This CLI backend does not support this action.",
    missing_cli:
      "Teams CLI was not found. Select an executable or download the verified CLI.",
    timeout: "Teams CLI took too long. Check the connection, then refresh.",
    cancelled: "The read was cancelled.",
    protocol:
      "Teams CLI returned an unexpected response. Check the CLI version and connection.",
    invalid_input: "Teams rejected the input. Check the profile and message.",
    transport: "Teams CLI stopped unexpectedly. Check the connection.",
    unconfirmed:
      "The send outcome is unknown. Check the conversation before sending another copy.",
  };
  return (
    messages[kind] ||
    "The operation failed. Show connection diagnostics, then try refreshing."
  );
}
