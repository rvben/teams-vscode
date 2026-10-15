import {
  avatarData,
  chatTime,
  filterChats,
  initials,
  sidebarLayout,
} from "../sidebar-model";
import type { ChatFilter, SidebarState } from "../sidebar-model";
declare function acquireVsCodeApi(): {
  postMessage(value: unknown): void;
  getState(): unknown;
  setState(value: unknown): void;
};
const vscode = acquireVsCodeApi();
const scope = document.body.dataset.scope ?? "";
const post = (type: string, extra: Record<string, unknown> = {}) =>
  vscode.postMessage({ type, scope, ...extra });
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}
function icon(name: "search" | "connection" | "chevron" | "group") {
  const paths = {
    search: "m10.8 10.8 3.2 3.2M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
    connection: "M5 1v4m6-4v4M3 5h10v2a5 5 0 0 1-10 0Zm5 7v3",
    chevron: "m5 6 3 3 3-3",
    group:
      "M10 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm-7 9v-1a5 5 0 0 1 10 0v1M12 2a2 2 0 0 1 0 4m2 3a4 4 0 0 1 1 3",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
function button(label: string, action: () => void, cls = "text-button") {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
const saved = vscode.getState() as
  { query?: unknown; filter?: unknown } | undefined;
let filter: ChatFilter = ["all", "unread", "groups"].includes(
  String(saved?.filter),
)
  ? (saved!.filter as ChatFilter)
  : "all";
let state: SidebarState | undefined;
const app = document.getElementById("app")!;
const header = el("header", "sidebar-header");
const accountRow = el("div", "account-row");
accountRow.hidden = true;
const profile = button(
  "Choose profile",
  () => post("profile"),
  "profile-button",
);
const profileName = el("span", "profile-name", "Teams");
profile.replaceChildren(profileName, icon("chevron"));
profile.title = "Choose Teams profile";
const connection = button("", () => post("connection"), "icon-button");
connection.append(icon("connection"));
connection.setAttribute("aria-label", "Show connection");
connection.title = "Show Teams connection";
accountRow.append(profile, connection);
const controlRow = el("div", "control-row");
const searchWrap = el("div", "search-wrap");
searchWrap.append(icon("search"));
const search = el("input");
search.type = "search";
search.placeholder = "Search loaded chats";
search.setAttribute("aria-label", "Search loaded chats");
search.value =
  typeof saved?.query === "string" ? saved.query.slice(0, 200) : "";
search.maxLength = 200;
searchWrap.append(search);
controlRow.append(searchWrap);
const options = el("div", "options-row");
const filters = el("div", "filters");
filters.setAttribute("role", "group");
filters.setAttribute("aria-label", "Filter chats");
const filterButtons = (
  [
    ["all", "All"],
    ["unread", "Unread"],
    ["groups", "Groups"],
  ] as const
).map(([key, label]) => {
  const b = button(
    label,
    () => {
      filter = key;
      persist();
      renderList();
    },
    "filter",
  );
  b.dataset.filter = key;
  filters.append(b);
  return b;
});
options.append(filters);
header.append(accountRow, controlRow, options);
const notice = el("div", "sidebar-notice");
notice.hidden = true;
const noticeText = el("p");
const recovery = button("Refresh", () =>
  post(
    state?.connection === "account"
      ? "selectAccount"
      : state?.ready
        ? "connection"
        : "setup",
  ),
);
notice.append(noticeText, recovery);
notice.setAttribute("role", "alert");
const content = el("section", "chat-list-region");
content.setAttribute("aria-label", "Chat list");
const skeleton = el("div", "skeletons");
skeleton.setAttribute("aria-hidden", "true");
for (let i = 0; i < 6; i++) {
  const row = el("div", "skeleton");
  row.append(el("span", "skeleton-avatar"), el("span", "skeleton-copy"));
  skeleton.append(row);
}
const list = el("div", "chat-list");
list.setAttribute("role", "listbox");
list.setAttribute("aria-label", "Conversations");
const empty = el("div", "empty-state");
empty.hidden = true;
const emptyTitle = el("h2");
const emptyText = el("p");
const emptyAction = el("button", "text-button", "Clear filters");
emptyAction.type = "button";
empty.append(emptyTitle, emptyText, emptyAction);
const more = button("Load more conversations", () => post("more"), "more");
more.hidden = true;
const listStatus = el("p", "sr-only");
listStatus.setAttribute("role", "status");
listStatus.setAttribute("aria-live", "polite");
content.append(skeleton, list, empty, more, listStatus);
const footer = el("footer", "sidebar-footer");
const provenance = el("p", "provenance");
footer.append(provenance);
app.append(el("h1", "sr-only", "Chats"), header, notice, content, footer);
function persist() {
  vscode.setState({ query: search.value, filter });
}
search.addEventListener("input", () => {
  persist();
  renderList();
});
search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    search.value = "";
    persist();
    renderList();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    list.querySelector<HTMLButtonElement>("button")?.focus();
  }
});
function renderList() {
  if (!state) return;
  const oldFocus =
    document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset.chat
      : undefined;
  const scroll = content.scrollTop;
  const visible = filterChats(state.chats, search.value, filter);
  const unread = state.chats.filter((c) => c.unread === true).length;
  for (const b of filterButtons) {
    b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
    b.textContent =
      b.dataset.filter === "unread" && unread
        ? `Unread ${unread}`
        : b.dataset.filter === "all"
          ? "All"
          : b.dataset.filter === "groups"
            ? "Groups"
            : "Unread";
  }
  const fragment = document.createDocumentFragment();
  for (const chat of visible) {
    const row = button(
      "",
      () => post("open", { id: chat.id, profile: state?.profile }),
      "chat-row",
    );
    row.dataset.chat = chat.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(state.selected === chat.id));
    row.tabIndex =
      chat.id === oldFocus ||
      (!oldFocus &&
        chat.id ===
          (visible.some((c) => c.id === state?.selected)
            ? state.selected
            : visible[0]?.id))
        ? 0
        : -1;
    row.classList.toggle("unread", chat.unread === true);
    const avatar = el(
      "span",
      `avatar ${chat.kind === "group" || chat.kind === "meeting" ? "group-avatar" : ""}`,
    );
    avatar.setAttribute("aria-hidden", "true");
    avatar.append(el("span", "initials", initials(chat.title)));
    const photo = avatarData(chat.avatar);
    if (photo) {
      const image = el("img");
      image.alt = "";
      image.src = photo;
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove(), { once: true });
      avatar.append(image);
    }
    const copy = el("span", "chat-copy");
    const top = el("span", "chat-top");
    const title = el("span", "chat-title", chat.title);
    const time = el("time", "chat-time", chatTime(chat.updated));
    if (chat.updated && Number.isFinite(Date.parse(chat.updated))) {
      time.dateTime = chat.updated;
      time.title = new Date(chat.updated).toLocaleString();
    }
    top.append(title, time);
    const preview = el(
      "span",
      "chat-preview",
      chat.preview || "No recent message",
    );
    copy.append(top, preview);
    row.append(avatar, copy);
    if (chat.unread === true) {
      const dot = el("span", "unread-dot");
      dot.setAttribute("aria-hidden", "true");
      row.append(dot);
    }
    row.setAttribute(
      "aria-label",
      `${chat.title}${chat.unread ? ", unread" : ""}${chat.kind === "group" ? ", group" : chat.kind === "meeting" ? ", meeting" : ""}${chat.preview ? ". " + chat.preview : ""}${time.textContent ? ". " + time.textContent : ""}`,
    );
    row.title = chat.title + (chat.preview ? "\n" + chat.preview : "");
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  content.scrollTop = scroll;
  if (oldFocus)
    Array.from(list.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.dataset.chat === oldFocus)
      ?.focus({ preventScroll: true });
  const initialLoading = state.loading && !state.chats.length;
  list.hidden = !visible.length;
  skeleton.hidden = !initialLoading;
  empty.hidden =
    !!visible.length || initialLoading || (!state.ready && !!state.error);
  const filtering = !!search.value.trim() || filter !== "all";
  emptyTitle.textContent = filtering
    ? "No matching chats"
    : state.ready
      ? "No conversations yet"
      : "Bring your chats into Code";
  emptyText.textContent =
    filter === "unread" && !state.chats.some((c) => c.unread !== undefined)
      ? "This connection does not report read status for the loaded chats."
      : filtering
        ? `Try another search or filter.${state.hasMore ? " You can also load more conversations." : ""}`
        : state.ready
          ? "Open a conversation in Teams, then refresh this list."
          : "Connect Teams Desktop or set up a Microsoft Graph profile.";
  emptyAction.hidden = !filtering && state.ready;
  emptyAction.textContent = filtering ? "Clear filters" : "Set up a connection";
  emptyAction.onclick = filtering
    ? () => {
        filter = "all";
        search.value = "";
        persist();
        renderList();
        search.focus();
      }
    : () => post("setup");
  more.hidden = !state.hasMore;
  more.disabled = state.loading;
  more.textContent = state.loading ? "Loading…" : "Load more conversations";
  content.setAttribute("aria-busy", String(state.loading));
  listStatus.textContent = state.loading
    ? "Loading conversations"
    : `${visible.length} ${visible.length === 1 ? "conversation" : "conversations"}${filtering ? " match" : " loaded"}${state.hasMore ? "; more available" : ""}`;
}
list.addEventListener("keydown", (e) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const rows = Array.from(
    list.querySelectorAll<HTMLButtonElement>(".chat-row"),
  );
  const current = rows.indexOf(document.activeElement as HTMLButtonElement);
  const index =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? rows.length - 1
        : Math.max(
            0,
            Math.min(
              rows.length - 1,
              current + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
  rows.forEach((r, i) => (r.tabIndex = i === index ? 0 : -1));
  rows[index]?.focus();
});
window.addEventListener("message", (event) => {
  const incoming = event.data;
  if (
    incoming?.type !== "sidebarState" ||
    incoming.state?.scope !== scope ||
    !Array.isArray(incoming.state.chats)
  )
    return;
  state = incoming.state as SidebarState;
  app.dataset.layout = sidebarLayout(state.layout);
  if (!state.canSwitchProfile && accountRow.contains(document.activeElement))
    search.focus();
  accountRow.hidden = !state.canSwitchProfile;
  profileName.textContent = state.profile
    ? state.accountLabel || "Teams account"
    : "Choose account";
  profile.title = state.profile
    ? `Choose a Teams connection\nProfile: ${state.profile}`
    : "Choose a Teams connection";
  notice.hidden = !state.error;
  noticeText.textContent = state.error;
  recovery.textContent =
    state.connection === "account"
      ? "Choose Teams account"
      : state.ready
        ? "Show connection"
        : "Set up a connection";
  provenance.textContent = state.cached
    ? "From Teams on this computer"
    : state.profile
      ? "From Microsoft 365"
      : "Your conversations stay in their account";
  provenance.title = state.cached
    ? "Shows chats available in Teams on this computer. Earlier chats may be missing."
    : "";
  connection.dataset.connected = String(state.connection === "connected");
  renderList();
});
post("ready");
