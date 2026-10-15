import { mkdir, open, readFile, unlink, rename, link } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface Pending {
  version: 1;
  operation: string;
  created: string;
  clientId: string;
  state: "sending" | "unknown";
  pid: number;
}
export class PendingConflict extends Error {
  constructor() {
    super("A previous send needs review before another message can be sent.");
  }
}
export class PendingStore {
  constructor(private root: string) {}
  key(scope: string): string {
    return createHash("sha256").update(scope).digest("hex");
  }
  private path(scope: string) {
    return join(this.root, this.key(scope) + ".json");
  }
  async read(scope: string): Promise<Pending | undefined> {
    try {
      const v = JSON.parse(await readFile(this.path(scope), "utf8")) as Pending;
      if (
        v.version !== 1 ||
        typeof v.operation !== "string" ||
        !v.operation ||
        typeof v.created !== "string" ||
        typeof v.clientId !== "string" ||
        !["sending", "unknown"].includes(v.state) ||
        !Number.isSafeInteger(v.pid) ||
        v.pid <= 0
      )
        throw new Error("invalid");
      return v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new PendingConflict();
    }
  }
  async claim(scope: string): Promise<Pending> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const record: Pending = {
      version: 1,
      operation: randomUUID(),
      created: new Date().toISOString(),
      clientId: "",
      state: "sending",
      pid: process.pid,
    };
    const temp = this.path(scope) + "." + record.operation + ".tmp";
    try {
      const f = await open(temp, "wx", 0o600);
      try {
        await f.writeFile(JSON.stringify(record));
        await f.sync();
      } finally {
        await f.close();
      }
      await link(temp, this.path(scope));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new PendingConflict();
      throw e;
    } finally {
      await unlink(temp).catch(() => {});
    }
    return record;
  }
  async markUnknown(
    scope: string,
    operation: string,
    clientId = "",
  ): Promise<void> {
    const v = await this.read(scope);
    if (!v || v.operation !== operation || v.pid !== process.pid)
      throw new PendingConflict();
    // Atomic replacement keeps the guard continuously present and readable in other windows.
    const temp = this.path(scope) + "." + randomUUID() + ".tmp";
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(JSON.stringify({ ...v, state: "unknown", clientId }));
      await f.sync();
    } finally {
      await f.close();
    }
    try {
      await rename(temp, this.path(scope));
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  isActive(v: Pending): boolean {
    if (v.state !== "sending") return false;
    try {
      process.kill(v.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  async clear(
    scope: string,
    operation: string,
    ownerCompleted = false,
  ): Promise<void> {
    const v = await this.read(scope);
    if (!v || v.operation !== operation) throw new PendingConflict();
    if (this.isActive(v) && !(ownerCompleted && v.pid === process.pid))
      throw new Error(
        "A send is still running in another window. Wait for it to finish.",
      );
    await unlink(this.path(scope));
  }
  async acknowledgeCorrupt(scope: string): Promise<void> {
    let corrupt = false;
    try {
      const v = await this.read(scope);
      if (v)
        throw new Error(
          "The send journal changed. Refresh before reviewing it.",
        );
      return;
    } catch (e) {
      if (e instanceof PendingConflict) corrupt = true;
      else throw e;
    }
    if (!corrupt) return;
    await unlink(this.path(scope)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
