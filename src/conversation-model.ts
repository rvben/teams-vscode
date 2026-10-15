import type { Chat, Message } from "./models";
import { avatarData } from "./sidebar-model";

// Photos belong to stable member identities in this chat and account only.
// A conversation photo or a matching display name cannot identify a sender.
export function withMemberAvatars(
  messages: Message[],
  chat: Pick<Chat, "memberAvatars">,
): Message[] {
  const photos = new Map<string, Set<string>>();
  for (const member of chat.memberAvatars ?? []) {
    const photo = avatarData(member.avatar);
    if (!member.senderId || !photo) continue;
    const choices = photos.get(member.senderId) ?? new Set<string>();
    choices.add(photo);
    photos.set(member.senderId, choices);
  }
  return messages.map((message) => {
    const choices = message.senderId ? photos.get(message.senderId) : undefined;
    return {
      ...message,
      avatar: choices?.size === 1 ? [...choices][0] : undefined,
    };
  });
}

// A display name is not an identity. Unknown senders always start a new group.
export function continuesMessage(
  previous: Message | undefined,
  current: Message,
): boolean {
  if (
    !previous?.senderId ||
    previous.senderId !== current.senderId ||
    previous.sender !== current.sender
  )
    return false;
  const before = new Date(previous.time),
    after = new Date(current.time);
  const gap = after.getTime() - before.getTime();
  return (
    Number.isFinite(gap) &&
    gap >= 0 &&
    gap <= 5 * 60_000 &&
    before.toDateString() === after.toDateString()
  );
}
