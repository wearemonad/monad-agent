import { Keychain } from "./Keychain";

/** Per-workspace credential values entered in the app's Settings UI.
 *
 *  Stored as one JSON blob per workspace in the macOS Keychain — per-machine and
 *  per-user, so a shared workspace folder (git/Drive) never carries secrets and
 *  each teammate provides their own keys. The workspace .env file remains a
 *  developer-only override underneath these. */
export class WorkspaceEnvStore {
  private service(workspaceId: string): string {
    return `monad-wsenv-${workspaceId}`;
  }

  get(workspaceId: string): Record<string, string> {
    try {
      return JSON.parse(Keychain.get(this.service(workspaceId)) ?? "{}");
    } catch {
      return {};
    }
  }

  set(workspaceId: string, name: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error("Invalid variable name.");
    const env = this.get(workspaceId);
    env[name] = value;
    Keychain.set(this.service(workspaceId), JSON.stringify(env));
  }

  clear(workspaceId: string, name: string): void {
    const env = this.get(workspaceId);
    delete env[name];
    if (Object.keys(env).length === 0) {
      Keychain.delete(this.service(workspaceId));
    } else {
      Keychain.set(this.service(workspaceId), JSON.stringify(env));
    }
  }

  /** Names only — values never travel to the webview. */
  names(workspaceId: string): string[] {
    return Object.keys(this.get(workspaceId));
  }

  deleteAll(workspaceId: string): void {
    Keychain.delete(this.service(workspaceId));
  }
}
