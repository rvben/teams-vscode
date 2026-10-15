import type { ViewState } from "../protocol";
import { continuesMessage, withMemberAvatars } from "../conversation-model";
import { avatarData, initials } from "../sidebar-model";
declare function acquireVsCodeApi(): { postMessage(value: unknown): void };
const vscode = acquireVsCodeApi();
const scope = document.body.dataset.scope ?? "";
const post = (type: string, extra: Record<string, unknown> = {}) =>
  vscode.postMessage({ type, scope, ...extra });
const app = document.getElementById("app")!;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}
function button(
  text: string,
  action: () => void,
  cls = "secondary",
): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
function avatar(name: string, photo: unknown, cls: string): HTMLSpanElement {
  const root = el("span", `person-avatar ${cls}`);
  root.setAttribute("aria-hidden", "true");
  root.append(el("span", "avatar-initials", initials(name)));
  const data = avatarData(photo);
  if (data) {
    const image = el("img");
    image.alt = "";
    image.src = data;
    image.addEventListener("error", () => image.remove(), { once: true });
    root.append(image);
  }
  return root;
}
function iconAction(
  label: string,
  path: string,
  action: () => void,
): HTMLButtonElement {
  const b = button("", action, "icon-action");
  b.setAttribute("aria-label", label);
  b.title = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  b.append(svg);
  return b;
}
const header = el("header", "header"),
  heading = el("h1", "", "Loading conversation…"),
  context = el("div", "context");
const accountDetails = el("details", "account-details");
const accountSummary = el("summary", "account-summary");
accountSummary.title = "Account and history details";
const accountName = el("span", "account-name", "Teams account");
const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
chevron.setAttribute("viewBox", "0 0 16 16");
chevron.setAttribute("aria-hidden", "true");
const chevronPath = document.createElementNS(chevron.namespaceURI, "path");
chevronPath.setAttribute("d", "m5 6 3 3 3-3");
chevron.append(chevronPath);
accountSummary.append(accountName, chevron);
const accountPanel = el("section", "account-panel");
accountPanel.setAttribute("aria-label", "Account and history details");
const accountDescription = el("p", "account-description");
const detailList = el("dl", "connection-facts");
function fact(label: string) {
  const value = el("dd");
  detailList.append(el("dt", "", label), value);
  return value;
}
const profileDetail = fact("Connection profile");
const sourceDetail = fact("Messages from");
const checkedDetail = fact("Last checked");
const cacheExplanation = el("p", "cache-explanation");
accountPanel.append(
  el("h2", "", "Account and history"),
  accountDescription,
  detailList,
  cacheExplanation,
  button("Show connection details", () => post("connection"), "detail-action"),
);
accountDetails.append(accountSummary, accountPanel);
const readOnlyLabel = el("span", "read-only-label", "Read-only");
readOnlyLabel.title = "Sending is disabled for this connection.";
context.append(accountDetails, readOnlyLabel);
accountDetails.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && accountDetails.open) {
    event.preventDefault();
    event.stopPropagation();
    accountDetails.open = false;
    accountSummary.focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!accountDetails.contains(event.target as Node))
    accountDetails.open = false;
});
accountDetails.addEventListener("focusout", (event) => {
  if (
    event.relatedTarget &&
    !accountDetails.contains(event.relatedTarget as Node)
  )
    accountDetails.open = false;
});
const titleGroup = el("div", "title-group");
titleGroup.append(heading, context);
const identity = el("div", "conversation-identity");
let headerAvatar = avatar("Teams", undefined, "conversation-avatar");
identity.append(headerAvatar, titleGroup);
const actions = el("div", "conversation-actions");
actions.setAttribute("role", "group");
actions.setAttribute("aria-label", "Conversation actions");
const refresh = iconAction(
  "Refresh messages",
  "M13.5 6A5.7 5.7 0 1 0 13 11M13.5 1.5V6H9",
  () => post("refresh"),
);
actions.append(
  refresh,
  iconAction(
    "Open Teams in browser",
    "M9.5 2H14v4.5M14 2 7.5 8.5M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3",
    () => post("openTeams"),
  ),
);
header.append(identity, actions);
const notice = el("div", "notice");
const noticeText = el("p");
const recover = button("Choose Teams account", () => {
  if (state?.recovery) post(state.recovery);
});
recover.hidden = true;
notice.append(noticeText, recover);
const historyStatus = el("p", "history-status visually-hidden");
historyStatus.id = "history-status";
notice.setAttribute("role", "status");
notice.setAttribute("aria-live", "polite");
const history = el("section", "history");
history.tabIndex = 0;
history.setAttribute("aria-label", "Message history");
history.setAttribute("aria-describedby", "history-status");
const historyInner = el("div", "history-inner");
const older = button(
  "Load older messages",
  () => post("older"),
  "secondary older",
);
const rows = el("div", "messages");
const empty = el("div", "empty");
const historyLimit = el(
  "p",
  "history-limit",
  "Earlier messages may be missing.",
);
historyLimit.hidden = true;
historyInner.append(older, historyLimit, empty, rows);
history.append(historyInner);
const jump = button(
  "New messages · jump to latest",
  () => {
    history.scrollTop = history.scrollHeight;
    jump.hidden = true;
  },
  "jump",
);
jump.hidden = true;
const pending = el("section", "pending");
pending.setAttribute("aria-label", "Previous send needs review");
pending.hidden = true;
const pendingTitle = el("strong", "", "Check the previous send");
const pendingText = el(
  "p",
  "",
  "Its outcome is unknown. Check the conversation in Teams before sending another copy.",
);
const pendingActions = el("div", "actions");
const check = button("Check send status", () => post("check"));
pendingActions.append(
  check,
  button("Open Teams", () => post("openTeams")),
  button("I checked in Teams…", () => post("acknowledge")),
);
pending.append(pendingTitle, pendingText, pendingActions);
const footer = el("footer", "composer");
const composerLabel = el("label", "composer-label", "Reply");
composerLabel.htmlFor = "draft";
const draft = el("textarea");
draft.id = "draft";
draft.rows = 3;
draft.maxLength = 32_000;
draft.placeholder = "Write a reply…";
draft.setAttribute("aria-describedby", "composer-help");
const footerRow = el("div", "composer-footer");
const help = el("span", "help");
help.id = "composer-help";
const send = button("Send", sendMessage, "primary");
const enable = button("Enable replies…", () => post("enableReplies"));
footerRow.append(help, enable, send);
footer.append(composerLabel, draft, footerRow);
app.append(header, historyStatus, notice, history, jump, pending, footer);
let state: ViewState | undefined,
  locallySending = false,
  priorSignature = "";
function sendMessage() {
  if (!state || !canSend() || locallySending) return;
  locallySending = true;
  send.disabled = true;
  post("draft", { text: draft.value });
  post("send");
}
function canSend() {
  return (
    !!state &&
    !state.readOnly &&
    state.repliesEnabled &&
    !state.pending &&
    state.recovery !== "selectAccount" &&
    !state.sending &&
    !!draft.value.trim()
  );
}
draft.addEventListener("input", () => {
  post("draft", { text: draft.value });
  send.disabled = !canSend() || locallySending;
  resize();
});
draft.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.repeat) return;
  if (
    (e.ctrlKey || e.metaKey || (state?.sendOnEnter && !e.shiftKey)) &&
    !e.altKey
  ) {
    e.preventDefault();
    sendMessage();
  }
});
function resize() {
  draft.style.height = "auto";
  draft.style.height = `${Math.min(220, Math.max(72, draft.scrollHeight))}px`;
}
history.addEventListener("scroll", () => {
  if (history.scrollHeight - history.scrollTop - history.clientHeight < 60)
    jump.hidden = true;
});
function render(s: ViewState) {
  const previous = state;
  state = s;
  locallySending = false;
  heading.textContent = s.title;
  if (!previous || previous.title !== s.title || previous.avatar !== s.avatar) {
    const replacement = avatar(s.title, s.avatar, "conversation-avatar");
    headerAvatar.replaceWith(replacement);
    headerAvatar = replacement;
  }
  accountName.textContent = s.accountLabel || "Teams account";
  readOnlyLabel.hidden = !s.readOnly;
  accountDescription.textContent =
    s.backend === "desktop"
      ? "Uses the account selected in Teams on this computer. Manage sign-in in Teams."
      : "Uses the Microsoft 365 account signed in to this connection.";
  profileDetail.textContent = s.profile;
  sourceDetail.textContent =
    s.backend === "desktop" ? "Teams on this computer" : "Microsoft 365";
  const date = s.updated ? new Date(s.updated) : undefined;
  const updated =
    date && Number.isFinite(date.getTime())
      ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : "";
  const cacheDetail = s.cached
    ? "Shows messages available in Teams on this computer. Earlier messages may be missing."
    : "";
  const freshness = updated ? `Last checked ${updated}.` : "";
  checkedDetail.textContent = updated || "Not checked yet";
  cacheExplanation.textContent = cacheDetail;
  cacheExplanation.hidden = !cacheDetail;
  refresh.disabled = s.busy;
  refresh.title = s.busy
    ? "Refreshing messages…"
    : ["Refresh messages", freshness].filter(Boolean).join("\n");
  refresh.setAttribute("aria-busy", String(s.busy));
  older.hidden = !s.cursor;
  older.disabled = s.busy;
  historyLimit.hidden = !s.cached || !!s.cursor || !s.messages.length;
  const status = cacheDetail || "Messages from Microsoft 365.";
  historyStatus.textContent = [status, freshness].filter(Boolean).join(" ");
  notice.classList.toggle("error", !!s.error);
  noticeText.textContent = s.error || s.note;
  notice.hidden = !noticeText.textContent;
  recover.hidden = !s.error || !s.recovery;
  recover.textContent =
    s.recovery === "selectAccount" ? "Choose Teams account" : "Show connection";
  recover.disabled = s.busy;
  notice.setAttribute("role", s.error ? "alert" : "status");
  empty.hidden = s.messages.length > 0;
  empty.textContent =
    s.busy && !s.messages.length
      ? "Loading messages…"
      : s.error
        ? "History is unavailable. Open Teams or check the connection, then refresh."
        : "No messages in this history. Refresh or open Teams to check the conversation.";
  history.setAttribute("aria-busy", String(s.busy));
  // Send each photo once per member, not once per message in long histories.
  const signature = JSON.stringify([s.messages, s.memberAvatars]);
  if (signature !== priorSignature) {
    const atBottom =
      !previous ||
      history.scrollHeight - history.scrollTop - history.clientHeight < 64;
    const oldHeight = history.scrollHeight,
      oldTop = history.scrollTop;
    const first = previous?.messages[0]?.id,
      last = previous?.messages.at(-1)?.id;
    rows.replaceChildren();
    let lastDay = "";
    let priorMessage: ViewState["messages"][number] | undefined;
    for (const m of withMemberAvatars(s.messages, s)) {
      const date = new Date(m.time),
        valid = !Number.isNaN(date.getTime()),
        day = valid
          ? date.toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : "Date unavailable";
      if (day !== lastDay) {
        rows.append(el("h2", "date", day));
        lastDay = day;
        priorMessage = undefined;
      }
      const row = el("article", "message");
      const continued = continuesMessage(priorMessage, m);
      row.classList.toggle("continued", continued);
      const meta = el("div", "message-meta");
      const name = el("span", "sender", m.sender);
      const time = el(
        "time",
        "time",
        valid
          ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "Time unavailable",
      );
      if (valid) time.dateTime = date.toISOString();
      const fullTime = valid
        ? date.toLocaleString(undefined, {
            dateStyle: "full",
            timeStyle: "short",
          })
        : "Time unavailable";
      time.title = fullTime;
      time.setAttribute("aria-label", fullTime);
      row.setAttribute("aria-label", `Message from ${m.sender}, ${fullTime}`);
      if (!continued) {
        row.append(avatar(m.sender, m.avatar, "message-avatar"));
        meta.append(name);
      }
      meta.append(time);
      const content = el("div", "message-content");
      content.append(el("p", "message-text", m.text));
      if (continued) content.append(meta);
      else row.append(meta);
      row.append(content);
      rows.append(row);
      priorMessage = m;
    }
    const prepended =
      !!first &&
      s.messages[0]?.id !== first &&
      s.messages.some((m) => m.id === first);
    if (prepended)
      history.scrollTop = oldTop + (history.scrollHeight - oldHeight);
    else if (atBottom) history.scrollTop = history.scrollHeight;
    else if (last && s.messages.at(-1)?.id !== last) jump.hidden = false;
    priorSignature = signature;
  }
  pending.hidden = !s.pending;
  check.hidden = !s.canCheck;
  check.disabled = s.sending;
  pendingTitle.textContent = s.sending
    ? "Sending to Teams…"
    : "Check the previous send";
  pendingText.textContent = s.sending
    ? "Wait for Teams to respond. Closing this tab will not retry or cancel the send."
    : "Its outcome is unknown. Check the conversation in Teams before sending another copy.";
  for (const b of pendingActions.querySelectorAll("button"))
    b.disabled = s.sending;
  if (draft.value !== s.draft) draft.value = s.draft;
  draft.disabled = s.sending || s.pending || s.readOnly || !s.repliesEnabled;
  draft.placeholder = s.readOnly
    ? "This connection is read-only."
    : !s.repliesEnabled
      ? "Enable replies to write a message."
      : s.pending
        ? "Review the previous send first."
        : "Write a reply…";
  help.textContent = s.readOnly
    ? "Choose a connection that allows replies."
    : s.pending
      ? "Sending is paused until the previous send is reviewed."
      : s.sendOnEnter
        ? "Enter to send · Shift+Enter for a new line"
        : `${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to send · Enter for a new line`;
  enable.hidden = s.repliesEnabled || s.readOnly;
  send.hidden = s.readOnly || !s.repliesEnabled;
  send.textContent = s.sending ? "Sending…" : "Send";
  send.disabled = !canSend();
  resize();
}
window.addEventListener("message", (e) => {
  if (e.data?.type === "state" && e.data.state?.scope === scope)
    render(e.data.state as ViewState);
});
post("ready");
