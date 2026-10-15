// Explicit, read-only live compatibility probe. Never prints identities or content.
import { Cli } from "../src/cli";
import { profiles, page, chat, message, obj } from "../src/models";
const executable = process.env.TEAMS_CLI_SMOKE;
if (!executable)
  throw new Error(
    "Set TEAMS_CLI_SMOKE to a trusted executable to run the read-only probe.",
  );
async function main() {
  const cli = new Cli(executable!);
  const version = await cli.verify();
  const list = profiles(await cli.call(["profile", "list"]));
  const selected = list.find((p) => p.backend === "desktop");
  if (!selected) {
    console.log(
      JSON.stringify({
        version,
        profiles: list.length,
        desktop: "no configured profile",
      }),
    );
    return;
  }
  const config = obj(
    await cli.call(["config", "show"], { profile: selected.name }),
  );
  const chats = page(
    await cli.call(["chats", "list", "--limit", "1"], {
      profile: selected.name,
    }),
    chat,
  );
  const messages = chats.items[0]
    ? page(
        await cli.call(
          ["messages", "list", "--chat", chats.items[0].id, "--limit", "5"],
          { profile: selected.name },
        ),
        message,
      )
    : undefined;
  console.log(
    JSON.stringify({
      version,
      profiles: list.length,
      backend: config.backend,
      chats: chats.items.length,
      messages: messages?.items.length ?? 0,
      cached: chats.cached,
      readOnly: true,
      sendAttempted: false,
    }),
  );
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      probe: "failed",
      kind: e.kind ?? "setup",
      sendAttempted: false,
    }),
  );
  process.exitCode = 1;
});
