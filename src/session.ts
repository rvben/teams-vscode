import { Api, CliError } from "./cli";
import {
  Message,
  Profile,
  message,
  page,
  mergeMessages,
  obj,
  str,
} from "./models";
import { Pending, PendingStore } from "./pending";

export class Conversation {
  messages: Message[] = [];
  cursor = "";
  cached = false;
  draft = "";
  busy = false;
  sending = false;
  error = "";
  operationError = "";
  errorKind = "";
  operationErrorKind = "";
  note = "";
  pending: Pending | undefined;
  corrupt = false;
  updated = "";
  private sequence = 0;
  private abort?: AbortController;
  private alive = true;
  private initialized = false;
  private checking = false;
  externalSending = false;
  constructor(
    readonly api: Api,
    readonly profile: Profile,
    readonly chatId: string,
    readonly scope: string,
    private store: PendingStore,
    private changed: () => void,
  ) {}
  async initialize() {
    try {
      this.pending = await this.store.read(this.scope);
      this.corrupt = false;
      this.externalSending =
        !!this.pending && this.store.isActive(this.pending);
    } catch {
      this.corrupt = true;
    }
    this.changed();
  }
  async refresh(older = false): Promise<void> {
    if (this.busy || !this.alive) return;
    this.busy = true;
    this.error = "";
    this.errorKind = "";
    const seq = ++this.sequence;
    this.abort = new AbortController();
    this.changed();
    try {
      if (!this.sending) {
        await this.initialize();
      }
      if (!this.alive || seq !== this.sequence) return;
      const args = [
        "messages",
        "list",
        "--chat",
        this.chatId,
        "--limit",
        "50",
        ...(older && this.cursor ? ["--cursor", this.cursor] : []),
      ];
      const p = page(
        await this.api.call(args, {
          profile: this.profile.name,
          signal: this.abort.signal,
        }),
        message,
      );
      if (!this.alive || seq !== this.sequence) return;
      this.messages = mergeMessages(this.messages, p.items);
      if (older || !this.initialized) this.cursor = p.cursor;
      this.cached = p.cached;
      this.initialized = true;
      this.updated = new Date().toISOString();
    } catch (e) {
      if (
        this.alive &&
        seq === this.sequence &&
        (e as CliError).kind !== "cancelled"
      ) {
        this.error = (e as Error).message;
        this.errorKind = e instanceof CliError ? e.kind : "";
      }
      throw e;
    } finally {
      if (this.alive && seq === this.sequence) {
        this.busy = false;
        this.changed();
      }
    }
  }
  async send(allow: boolean): Promise<void> {
    if (!this.alive || this.sending || !this.draft.trim()) return;
    if (!allow || this.profile.readOnly)
      throw new Error("Replies are disabled for this profile.");
    if (this.pending || this.corrupt)
      throw new Error("Review the previous send first.");
    const body = this.draft;
    let pending: Pending;
    try {
      pending = await this.store.claim(this.scope);
    } catch (e) {
      try {
        this.pending = await this.store.read(this.scope);
      } catch {
        this.corrupt = true;
      }
      this.changed();
      throw e;
    }
    this.pending = pending;
    this.sending = true;
    this.externalSending = false;
    this.error = "";
    this.operationError = "";
    this.operationErrorKind = "";
    this.note = "";
    this.changed();
    try {
      const result = obj(
        await this.api.call(
          ["--yes", "messages", "send", "--chat", this.chatId, "--body", "-"],
          { profile: this.profile.name, body, mutation: true },
        ),
      );
      if (!str(result.id)) throw new CliError("protocol", true);
      if (
        result.delivery_state === "unknown" ||
        result.delivery_state === "failed"
      )
        throw new CliError(
          "unconfirmed",
          true,
          /^\d{18}$/.test(str(result.clientMessageId))
            ? str(result.clientMessageId)
            : "",
        );
      await this.store.clear(this.scope, pending.operation, true);
      this.pending = undefined;
      if (this.draft === body) this.draft = "";
      const delivery = str(result.delivery_state);
      this.note =
        delivery === "delivered"
          ? "Delivered."
          : "Submitted to Teams. Refresh to see it in history.";
    } catch (e) {
      if (e instanceof CliError && !e.uncertain) {
        await this.store.clear(this.scope, pending.operation, true);
        this.pending = undefined;
      } else {
        const clientId = e instanceof CliError ? e.clientId : "";
        try {
          await this.store.markUnknown(this.scope, pending.operation, clientId);
          this.pending = { ...pending, state: "unknown", clientId };
        } catch {
          this.corrupt = true;
        }
        this.note = "Send outcome unknown. Check before sending another copy.";
      }
      this.operationError = (e as Error).message;
      this.operationErrorKind = e instanceof CliError ? e.kind : "";
    } finally {
      this.sending = false;
      this.externalSending = false;
      if (this.alive) this.changed();
    }
    if (this.alive) await this.refresh().catch(() => {});
  }
  async check(): Promise<void> {
    if (this.checking || this.sending) return;
    this.checking = true;
    try {
      await this.checkOnce();
    } finally {
      this.checking = false;
    }
  }
  private async checkOnce(): Promise<void> {
    const pending = this.pending;
    if (!pending?.clientId) {
      this.note =
        "No reconciliation ID is available. Check the conversation in Teams, then acknowledge the previous send.";
      this.changed();
      return;
    }
    const result = obj(
      await this.api.call(
        [
          "messages",
          "status",
          "--chat",
          this.chatId,
          "--client-message-id",
          pending.clientId,
        ],
        { profile: this.profile.name },
      ),
    );
    if (this.pending?.operation !== pending.operation) return;
    if (
      result.clientMessageId !== pending.clientId ||
      result.chatId !== this.chatId ||
      result.found !== true
    ) {
      this.note =
        "Not confirmed in the newest cached messages. This does not prove it was not sent.";
      this.changed();
      return;
    }
    const state = str(result.delivery_state);
    if (state === "delivered" || state === "submitted" || state === "queued") {
      await this.store.clear(this.scope, pending.operation);
      this.pending = undefined;
      this.draft = "";
      this.note =
        state === "delivered"
          ? "Delivery confirmed."
          : "Found in Teams. " +
            (state === "queued" ? "Still queued." : "Submitted.");
    } else
      this.note =
        state === "failed"
          ? "Teams reports a failed send. Review it in Teams before sending another copy."
          : "Not confirmed in the newest cached messages. This does not prove it was not sent.";
    this.changed();
    await this.refresh().catch(() => {});
  }
  async acknowledge() {
    if (this.sending) return;
    if (this.corrupt) await this.store.acknowledgeCorrupt(this.scope);
    else if (this.pending)
      await this.store.clear(this.scope, this.pending.operation);
    this.pending = undefined;
    this.externalSending = false;
    this.corrupt = false;
    this.note = "Previous send reviewed. Your draft is ready to edit.";
    this.operationError = "";
    this.operationErrorKind = "";
    this.changed();
  }
  get recovery(): "selectAccount" | "connection" | undefined {
    const kind = this.errorKind || this.operationErrorKind;
    if (kind === "desktop_account_ambiguous") return "selectAccount";
    if (kind.startsWith("desktop_")) return "connection";
    return undefined;
  }
  dispose() {
    this.alive = false;
    ++this.sequence;
    this.abort?.abort();
  }
}
