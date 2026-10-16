// Synthetic fixture only. Never included in the VSIX.
const a = process.argv.slice(2);
const has = (x, y) => a.includes(x) && a.includes(y);
const out = (value) => console.log(JSON.stringify(value));
if (a.includes("schema"))
  out({
    version: "0.2.2",
    commands: [
      "profile list",
      "chats list",
      "messages list",
      "messages send",
      "messages status",
    ]
      .map((name) => ({ name }))
      .concat([
        {
          name: "init",
          args: [{ name: "--desktop-client" }, { name: "--auto-start" }],
        },
        { name: "desktop login" },
        { name: "desktop supervise" },
      ]),
  });
else if (has("desktop", "supervise")) {
  out({ protocol: 1, client: "1234567890abcdef1234567890abcdef" });
  process.stdin.resume();
} else if (
  process.env.TEAMS_COMPANION_TEST_MIXED_ACCOUNTS === "1" &&
  a[a.indexOf("--profile") + 1] === "personal-demo" &&
  (has("chats", "list") || has("messages", "list"))
) {
  console.error(
    JSON.stringify({
      error: {
        kind: "desktop_error",
        message:
          "Multiple Teams accounts are available; use an explicit selector",
      },
    }),
  );
  process.exitCode = 5;
} else if (has("profile", "list"))
  out({
    items: [
      {
        name: "personal-demo",
        backend: "desktop",
        read_only: true,
        active: true,
      },
      { name: "work-demo", backend: "graph", read_only: false },
    ],
    total: 2,
  });
else if (has("auth", "status")) {
  if (process.env.TEAMS_COMPANION_TEST_AUTH_UNKNOWN === "1") {
    console.error(
      JSON.stringify({
        error: { kind: "auth", message: "Synthetic auth metadata unavailable" },
      }),
    );
    process.exitCode = 1;
  } else
    out({
      signed_in: process.env.TEAMS_COMPANION_TEST_SIGNED_OUT !== "1",
      verified:
        process.env.TEAMS_COMPANION_TEST_SIGNED_OUT !== "1" &&
        process.env.TEAMS_COMPANION_TEST_AUTH_UNVERIFIED !== "1",
    });
} else if (has("desktop", "status"))
  out({
    endpoint_available: true,
    session_verified: false,
    management: { managed: true, needs_recovery: false },
    connection: { status: "metadata_ok" },
  });
else if (has("config", "show"))
  out({
    profile: a[a.indexOf("--profile") + 1],
    backend:
      a[a.indexOf("--profile") + 1] === "work-demo" ? "graph" : "desktop",
    read_only: true,
    config_path: "/synthetic/teams/config.toml",
    desktop_account: "personal",
  });
else if (
  has("chats", "list") &&
  process.env.TEAMS_COMPANION_TEST_PAGES === "1"
) {
  const offset = Number(a[a.indexOf("--cursor") + 1]) || 0;
  out({
    items: Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => ({
      id: `synthetic-chat-${offset + i + 1}`,
      topic: `Synthetic paginated conversation ${offset + i + 1}`,
      chatType: "group",
    })),
    next_cursor: offset + 50 < 120 ? String(offset + 50) : null,
    source: "desktop_cache",
  });
} else if (has("chats", "list"))
  out({
    items: [
      {
        id: "synthetic-chat-1",
        topic: "Synthetic conversation",
        chatType: "group",
        members: [
          {
            userId: "sample-user",
            displayName: "Sample user",
            avatarData: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
      {
        id: "synthetic-chat-2",
        topic: "Synthetic second conversation",
        chatType: "oneOnOne",
      },
    ],
    source: "desktop_cache",
  });
else if (has("messages", "list"))
  out({
    items: [
      {
        id: "synthetic-message-1",
        createdDateTime: "2026-10-14T12:00:00Z",
        from: { user: { id: "sample-user", displayName: "Sample user" } },
        body: { contentType: "text", content: "Synthetic test message" },
      },
    ],
    source: "desktop_cache",
  });
else if (a.length === 1 && a[0] === "init") out({ synthetic_setup: true });
else {
  console.error(
    JSON.stringify({
      error: {
        kind: "unsupported",
        message: "Synthetic fixture does not permit writes.",
      },
    }),
  );
  process.exitCode = 1;
}
