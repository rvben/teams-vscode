import type { Cli } from "./cli";
import { obj, profiles, str, type Profile } from "./models";

/** Join browser ownership before the old supervisor is released. Connection
 * check failures leave the verified candidate pending, rather than losing it.
 * `desktop status` only probes; a stopped browser is a successful offline result. */
export async function joinBrowsers(
  api: Pick<Cli, "call" | "startBrowserLifetime">,
  selected: Profile[],
  keepAlive: boolean,
  failed?: (error: unknown) => void,
): Promise<boolean> {
  try {
    const available = new Set(
      profiles(await api.call(["profile", "list"])).map(
        (profile) => profile.name,
      ),
    );
    for (const profile of selected) {
      if (profile.backend !== "desktop" || !available.has(profile.name))
        continue;
      const config = obj(
        await api.call(["config", "show"], { profile: profile.name }),
      );
      if (
        !["browser", "browser_core", "browser-core"].includes(
          str(config.desktop_client),
        )
      )
        continue;
      await api.startBrowserLifetime(keepAlive);
      await api.call(["desktop", "status"], {
        profile: profile.name,
        timeout: 30_000,
      });
    }
    return true;
  } catch (error) {
    failed?.(error);
    return false;
  }
}
