import { Api, CliError } from "./cli";
import { obj, str, type Chat } from "./models";
import { PendingStore, PendingConflict } from "./pending";

export interface Recipient {
  id: string;
  name: string;
  email: string;
}
export function recipient(value: unknown): Recipient | undefined {
  const v = obj(value),
    id = str(v.id),
    name = str(v.displayName),
    email = str(v.email);
  if (!id || id.length > 256 || /[\s\x00-\x1f]/.test(id) || !name.trim())
    return;
  return { id, name, email };
}
export async function searchRecipients(
  api: Api,
  profile: string,
  query: string,
  signal?: AbortSignal,
) {
  query = query.trim();
  if (query.length < 2 || query.length > 256 || /[\x00-\x1f]/.test(query))
    return { items: [], truncated: false };
  const result = obj(
    await api.call(["people", "search", query, "--limit", "20"], {
      profile,
      signal,
    }),
  );
  if (!Array.isArray(result.items)) throw new CliError("protocol");
  const seen = new Set<string>();
  return {
    items: result.items
      .map(recipient)
      .filter((r): r is Recipient => !!r)
      .filter((r) => !seen.has(r.id) && !!seen.add(r.id))
      .slice(0, 20),
    truncated: result.truncated === true,
  };
}
// Separate from message outbox records: this operation never contains or sends a message.
export async function createConversation(
  api: Api,
  store: PendingStore,
  profile: string,
  scope: string,
  to: Recipient,
): Promise<Chat> {
  let pending;
  try {
    pending = await store.claim(scope);
  } catch (error) {
    throw new Error(
      error instanceof PendingConflict
        ? "A previous conversation request needs review in Teams before trying again."
        : "Couldn’t save this conversation request. Check local storage and try again.",
    );
  }
  try {
    const result = obj(
      await api.call(["--yes", "chats", "create", "--recipient", to.id], {
        profile,
        mutation: true,
      }),
    );
    const id = str(result.id);
    if (!id || id.length > 256 || /[\s\x00-\x1f]/.test(id))
      throw new CliError("protocol", true);
    await store.clear(scope, pending.operation, true);
    return { id, title: to.name, preview: "", kind: "oneOnOne" };
  } catch (error) {
    if (error instanceof CliError && !error.uncertain)
      await store.clear(scope, pending.operation, true);
    else await store.markUnknown(scope, pending.operation).catch(() => {});
    throw error;
  }
}
