import test from "node:test";
import assert from "node:assert/strict";
import {
  UpdateChecker,
  newerVersion,
  selectRelease,
  fetchReleases,
  type ExtensionRelease,
} from "../src/updates";

function release(version = "0.1.3", experimental = true) {
  const base = "https://github.com/rvben/teams-vscode/releases";
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: experimental,
    html_url: `${base}/tag/v${version}`,
    published_at: "2026-10-15T12:00:00Z",
    assets: ["SHA256SUMS", `teams-companion-${version}.vsix`].map((name) => ({
      name,
      state: "uploaded",
      browser_download_url: `${base}/download/v${version}/${name}`,
    })),
  };
}
test("update discovery includes experimental downloads, compares versions numerically, and requires published assets", () => {
  assert.equal(
    selectRelease(
      [release("0.1.10"), release("0.1.3"), release("0.1.2")],
      "0.1.2",
      true,
    )?.version,
    "0.1.10",
  );
  assert.equal(selectRelease([release()], "0.1.2", false), undefined);
  assert.equal(
    selectRelease([release("0.1.3", false)], "0.1.2", false)?.version,
    "0.1.3",
  );
  for (const patch of [
    { draft: true },
    { prerelease: "true" },
    { published_at: null },
    { html_url: "https://example.test/update" },
    { assets: [] },
    {
      assets: release().assets.map((a) => ({
        ...a,
        browser_download_url: "https://example.test/file",
      })),
    },
    { assets: release().assets.map((a) => ({ ...a, state: "new" })) },
    { tag_name: "v01.1.3" },
    { tag_name: "v0.1.3/../../other" },
  ])
    assert.equal(
      selectRelease([{ ...release(), ...patch }], "0.1.2", true),
      undefined,
    );
  for (const version of [
    "0.1.2",
    "0.1.1",
    "0.1.3-alpha",
    "NaN.1.0",
    "99999999999999999999999.1.0",
  ])
    assert.equal(newerVersion(version, "0.1.2"), false);
  assert.throws(() => selectRelease({}, "0.1.2", true));
});
function fixture() {
  const state = new Map<string, unknown>();
  const events: string[] = [];
  let enabled = true,
    now = 1_000_000_000;
  const host = {
    get: <T>(key: string) => state.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      state.set(key, value);
    },
    enabled: () => enabled,
    fetch: async (): Promise<unknown> => {
      events.push("fetch");
      return [release()];
    },
    available: async (
      _r: ExtensionRelease,
    ): Promise<"open" | "skip" | undefined> => {
      events.push("available");
      return undefined;
    },
    open: async (url: string) => {
      assert.equal(url, release().html_url);
      events.push("open");
    },
    current: async () => {
      events.push("current");
    },
    failed: async () => {
      events.push("failed");
    },
    now: () => now,
  };
  return {
    state,
    events,
    host,
    checker: new UpdateChecker("0.1.2", true, host),
    disable: () => {
      enabled = false;
    },
    advance: () => {
      now += 24 * 60 * 60 * 1000;
    },
  };
}
test("automatic update checks are daily, respect opt-out, and skipped versions can still be checked manually", async () => {
  const f = fixture();
  f.host.available = async () => {
    f.events.push("available");
    return "skip";
  };
  await f.checker.check();
  assert.equal(f.state.get("updates.skippedVersion"), "0.1.3");
  await f.checker.check();
  assert.deepEqual(f.events, ["fetch", "available"]);
  f.advance();
  await f.checker.check();
  assert.deepEqual(f.events, ["fetch", "available", "fetch"]);
  f.disable();
  f.advance();
  await f.checker.check();
  assert.equal(f.events.length, 3);
  f.host.available = async () => {
    f.events.push("available");
    return "open";
  };
  await f.checker.check(true);
  assert.deepEqual(f.events.slice(-3), ["fetch", "available", "open"]);
});
test("automatic failures stay quiet and are throttled; manual errors get feedback", async () => {
  const f = fixture();
  f.host.fetch = async () => {
    f.events.push("fetch");
    throw new Error("synthetic network error");
  };
  await f.checker.check();
  await f.checker.check();
  assert.deepEqual(f.events, ["fetch"]);
  await f.checker.check(true);
  assert.deepEqual(f.events, ["fetch", "fetch", "failed"]);
});
test("a manual check joins an in-flight automatic check and still receives an up-to-date result", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.host.fetch = () => {
    f.events.push("fetch");
    return new Promise((r) => {
      resolve = r;
    });
  };
  const pending = f.checker.check();
  await new Promise(setImmediate);
  assert.equal(f.checker.check(true), pending);
  resolve([]);
  await pending;
  assert.deepEqual(f.events, ["fetch", "current"]);
});
test("disabling or disposing during a request prevents late automatic notifications", async () => {
  for (const action of ["disable", "dispose"]) {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.host.fetch = () =>
      new Promise((r) => {
        resolve = r;
      });
    const pending = f.checker.check();
    await new Promise(setImmediate);
    if (action === "disable") f.disable();
    else f.checker.dispose();
    resolve([release()]);
    await pending;
    assert.deepEqual(f.events, []);
  }
});
test("release requests use only fixed public metadata, a generic identifier, a timeout, and no redirects", async () => {
  const fetcher: typeof fetch = async (input, options) => {
    assert.equal(
      input,
      "https://api.github.com/repos/rvben/teams-vscode/releases?per_page=30",
    );
    assert.equal(options?.redirect, "error");
    assert(options?.signal instanceof AbortSignal);
    assert.deepEqual(options?.headers, {
      Accept: "application/vnd.github+json",
      "User-Agent": "teams-companion",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    return new Response(JSON.stringify([release()]));
  };
  assert.deepEqual(await fetchReleases(fetcher), [release()]);
  await assert.rejects(
    fetchReleases(async () => new Response("{}", { status: 429 })),
  );
  await assert.rejects(
    fetchReleases(async () => new Response("x".repeat(1024 * 1024 + 1))),
    /size limit/,
  );
  await assert.rejects(fetchReleases(async () => new Response("not JSON")));
});
