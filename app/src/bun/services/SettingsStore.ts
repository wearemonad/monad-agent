import * as path from "node:path";
import * as os from "node:os";
import {
  AUTH_MODES,
  PROVIDER_IDS,
  type AuthMode,
  type ProviderId,
} from "../../shared/ipc";
import { IMAGE_PROVIDER_IDS, type ImageProviderId } from "../../shared/images";
import { GOOGLE_CLIENT_DEFAULTS } from "../googleClientDefaults";
import type { ImageSettings } from "./images/ImageGeneration";
import { Keychain, KeychainServices } from "./Keychain";
import { readJsonAtomic, writeJsonAtomic } from "./atomicJson";

type SettingsFile = {
  /** Provider used when a run names none (background jobs, ingest, scheduler). */
  authMode: AuthMode;
  /** Providers the user switched on; the default one is always included. */
  enabledProviders?: ProviderId[];
  claudeBinaryPath?: string;
  /** Override for the Codex CLI (OpenAI subscription provider). */
  codexBinaryPath?: string;
  /** Default Ollama model for local-mode runs (an Ollama tag). */
  localModel?: string;
  googleClientId?: string;
  /** Settings → Image models: the provider used when several have a key. */
  imageDefaultProvider?: ImageProviderId;
  /** Per-provider image model override (DEFAULT_IMAGE_MODELS otherwise). */
  imageModels?: Partial<Record<ImageProviderId, string>>;
};

const CONFIG_DIR = path.join(os.homedir(), "Library/Application Support/Monad");
const CONFIG = path.join(CONFIG_DIR, "settings.json");

export class SettingsStore {
  private data: SettingsFile;

  constructor() {
    this.data = this.load();
  }

  get authMode(): AuthMode {
    return this.data.authMode;
  }

  /** Providers the composer may pick models from. The default provider is
   *  always in the list — switching every provider off would leave no way to
   *  run anything, so it is not an expressible state. */
  get enabledProviders(): ProviderId[] {
    const stored = this.data.enabledProviders ?? [this.data.authMode];
    const set = new Set(stored.filter((p) => PROVIDER_IDS.includes(p)));
    set.add(this.data.authMode);
    return PROVIDER_IDS.filter((p) => set.has(p));
  }

  isProviderEnabled(id: ProviderId): boolean {
    return this.enabledProviders.includes(id);
  }

  get claudeBinaryPath(): string | undefined {
    return this.data.claudeBinaryPath;
  }

  get codexBinaryPath(): string | undefined {
    return this.data.codexBinaryPath;
  }

  get localModel(): string | undefined {
    return this.data.localModel;
  }

  /** Settings-entered override wins; otherwise the client shipped with the app. */
  get googleClientId(): string | undefined {
    return (
      this.data.googleClientId || GOOGLE_CLIENT_DEFAULTS.clientId || undefined
    );
  }

  getGoogleClientSecret(): string | null {
    return (
      Keychain.get(KeychainServices.googleClientSecret) ||
      GOOGLE_CLIENT_DEFAULTS.clientSecret ||
      null
    );
  }

  /** True when the app ships a usable built-in Google client. */
  hasBuiltInGoogleClient(): boolean {
    return (
      !!GOOGLE_CLIENT_DEFAULTS.clientId && !!GOOGLE_CLIENT_DEFAULTS.clientSecret
    );
  }

  getApiKey(): string | null {
    return Keychain.get(KeychainServices.anthropicApiKey);
  }

  hasApiKey(): boolean {
    return !!this.getApiKey();
  }

  getOpenAIApiKey(): string | null {
    return Keychain.get(KeychainServices.openaiApiKey);
  }

  hasOpenAIApiKey(): boolean {
    return !!this.getOpenAIApiKey();
  }

  getImageApiKey(id: ImageProviderId): string | null {
    return Keychain.get(KeychainServices.imageApiKey(id));
  }

  /** Everything image routing needs, read fresh (keys from the Keychain). */
  imageSettings(): ImageSettings {
    const keys: ImageSettings["keys"] = {};
    for (const id of IMAGE_PROVIDER_IDS) keys[id] = this.getImageApiKey(id);
    return {
      ...(this.data.imageDefaultProvider
        ? { defaultProvider: this.data.imageDefaultProvider }
        : {}),
      keys,
      models: { ...this.data.imageModels },
    };
  }

  update(patch: {
    authMode?: AuthMode;
    enabledProviders?: ProviderId[];
    claudeBinaryPath?: string | null;
    codexBinaryPath?: string | null;
    localModel?: string | null;
    googleClientId?: string | null;
    apiKey?: string; // write-only
    openaiApiKey?: string; // write-only
    googleClientSecret?: string; // write-only
    /** Write-only; "" or null removes the key. */
    imageApiKeys?: Partial<Record<ImageProviderId, string | null>>;
    imageDefaultProvider?: ImageProviderId | null;
    /** "" or null resets a provider to its default model. */
    imageModels?: Partial<Record<ImageProviderId, string | null>>;
  }): void {
    // Keychain writes FIRST: a denied/locked keychain prompt throws, and it
    // must do so before any in-memory mutation — otherwise the unrelated
    // settings in the same patch are half-applied in memory but never saved,
    // leaving memory diverged from disk.
    if (patch.apiKey)
      Keychain.set(KeychainServices.anthropicApiKey, patch.apiKey);
    if (patch.openaiApiKey)
      Keychain.set(KeychainServices.openaiApiKey, patch.openaiApiKey);
    if (patch.googleClientSecret) {
      Keychain.set(
        KeychainServices.googleClientSecret,
        patch.googleClientSecret,
      );
    }
    const imageKeys = Object.entries(patch.imageApiKeys ?? {}).filter(([id]) =>
      IMAGE_PROVIDER_IDS.includes(id as ImageProviderId),
    ) as [ImageProviderId, string | null][];
    for (const [id, key] of imageKeys) {
      if (key?.trim())
        Keychain.set(KeychainServices.imageApiKey(id), key.trim());
      else Keychain.delete(KeychainServices.imageApiKey(id));
    }
    // The first key added becomes the default image model; removing the
    // default's key hands the role to another provider that has one.
    for (const [id, key] of imageKeys) {
      if (key?.trim()) this.data.imageDefaultProvider ??= id;
      else if (this.data.imageDefaultProvider === id) {
        this.data.imageDefaultProvider = IMAGE_PROVIDER_IDS.find(
          (p) => p !== id && !!this.getImageApiKey(p),
        );
      }
    }
    if (patch.imageDefaultProvider !== undefined) {
      const next = patch.imageDefaultProvider;
      this.data.imageDefaultProvider =
        next && IMAGE_PROVIDER_IDS.includes(next) ? next : undefined;
    }
    for (const [id, model] of Object.entries(patch.imageModels ?? {})) {
      if (!IMAGE_PROVIDER_IDS.includes(id as ImageProviderId)) continue;
      const models = { ...this.data.imageModels };
      if (model?.trim()) models[id as ImageProviderId] = model.trim();
      else delete models[id as ImageProviderId];
      this.data.imageModels = models;
    }
    // Only Claude-runtime providers can be the default (see AuthMode).
    const authMode =
      patch.authMode && AUTH_MODES.includes(patch.authMode)
        ? patch.authMode
        : undefined;
    if (authMode) this.data.authMode = authMode;
    if (patch.enabledProviders) {
      const next = PROVIDER_IDS.filter((p) =>
        patch.enabledProviders!.includes(p),
      );
      this.data.enabledProviders = next;
      // Switching off the default provider hands the role to the next
      // Claude-runtime one still enabled — background runs must always have
      // somewhere to go. With none left, the default simply stays on (the
      // enabledProviders getter always includes it).
      const nextDefault = AUTH_MODES.find((p) => next.includes(p));
      if (nextDefault && !next.includes(this.data.authMode)) {
        this.data.authMode = nextDefault;
      }
    }
    // Making a provider the default implies it is enabled.
    if (authMode && this.data.enabledProviders) {
      this.data.enabledProviders = PROVIDER_IDS.filter(
        (p) => p === authMode || this.data.enabledProviders!.includes(p),
      );
    }
    if (patch.claudeBinaryPath !== undefined) {
      this.data.claudeBinaryPath = patch.claudeBinaryPath || undefined;
    }
    if (patch.codexBinaryPath !== undefined) {
      this.data.codexBinaryPath = patch.codexBinaryPath || undefined;
    }
    if (patch.localModel !== undefined) {
      this.data.localModel = patch.localModel || undefined;
    }
    if (patch.googleClientId !== undefined) {
      this.data.googleClientId = patch.googleClientId || undefined;
    }
    this.save();
  }

  private load(): SettingsFile {
    const data = readJsonAtomic<Partial<SettingsFile>>(CONFIG, () => ({}), {
      onCorrupt: (m) => console.error(`[settings] ${m}`),
    });
    return { authMode: "subscription-cli", ...data };
  }

  private save() {
    writeJsonAtomic(CONFIG, this.data);
  }
}
