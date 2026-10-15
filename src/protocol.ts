import type { Chat, Message } from "./models";
export interface ViewState {
  scope: string;
  title: string;
  avatar?: string;
  memberAvatars?: Chat["memberAvatars"];
  profile: string;
  accountLabel: string;
  backend: string;
  cached: boolean;
  readOnly: boolean;
  repliesEnabled: boolean;
  messages: Message[];
  cursor: string;
  draft: string;
  busy: boolean;
  sending: boolean;
  error: string;
  recovery?: "selectAccount" | "connection";
  note: string;
  updated: string;
  pending: boolean;
  canCheck: boolean;
  sendOnEnter: boolean;
}
