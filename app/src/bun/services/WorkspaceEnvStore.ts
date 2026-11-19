import { Keychain, KeychainServices } from "./Keychain";

/** Per-workspace credential values entered in the app's Settings UI.
 *
 *  Stored as one JSON blob per workspace in the macOS Keychain — per-machine and
 *  per-user, so a shared workspace folder (git/Drive) never carries secrets and
 *  each teammate provides their own keys. The workspace .env file remains a
 *  developer-only override underneath these. */
export class WorkspaceEnvStore {
  private service(workspaceId: string): string {
    return KeychainServices.workspaceEnv(workspaceId);
  }

  /** Synchronous: reads the Keychain cache index.ts warms at boot. */
  get(workspaceId: string): Record<string, string> {
    try {
      return JSON.parse(Keychain.get(this.service(workspaceId)) ?? "{}");
    } catch {
      return {};
    }
  }

  async set(workspaceId: string, name: string, value: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error("Invalid variable name.");
    const env = this.get(workspaceId);
    env[name] = value;
    await Keychain.set(this.service(workspaceId), JSON.stringify(env));
  }

  async clear(workspaceId: string, name: string): Promise<void> {
    const env = this.get(workspaceId);
    delete env[name];
    if (Object.keys(env).length === 0) {
      await Keychain.delete(this.service(workspaceId));
    } else {
      await Keychain.set(this.service(workspaceId), JSON.stringify(env));
    }
  }

  /** Names only — values never travel to the webview. */
  names(workspaceId: string): string[] {
    return Object.keys(this.get(workspaceId));
  }

  deleteAll(workspaceId: string): Promise<void> {
    return Keychain.delete(this.service(workspaceId));
  }
}
