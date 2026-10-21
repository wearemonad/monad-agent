import * as fs from "node:fs";
import * as os from "node:os";
import type {
  LocalModel,
  LocalModelFit,
  OllamaStatus,
  RecommendedModel,
} from "../../shared/ipc";

/** Ollama v0.14+ speaks Anthropic's Messages API natively at /v1/messages, so
 *  the Claude Agent SDK talks to it with nothing but an ANTHROPIC_BASE_URL
 *  override — no translation proxy. This service owns everything around that:
 *  install/running detection, the installed-model list with RAM-fit verdicts,
 *  and guided model downloads. */
/** Honor OLLAMA_HOST (host, host:port, or full URL) for users who run Ollama on
 *  another port/machine; default to the standard local endpoint. */
export const OLLAMA_URL = resolveOllamaUrl(process.env.OLLAMA_HOST);

function resolveOllamaUrl(host: string | undefined): string {
  const h = host?.trim();
  if (!h) return "http://localhost:11434";
  if (/^https?:\/\//i.test(h)) return h.replace(/\/+$/, "");
  return `http://${h.includes(":") ? h : `${h}:11434`}`;
}

const APP_PATH = "/Applications/Ollama.app";
const BIN_CANDIDATES = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"];

/** Curated download list, smallest viable set. Tags track ollama.com/library —
 *  verify them when bumping this list; a renamed tag fails the pull with a
 *  clear error rather than breaking anything. minRamGb is the vendor-stated
 *  floor; fit verdicts derive from it (see recommendedFit). */
export const RECOMMENDED_MODELS: Omit<
  RecommendedModel,
  "installed" | "fit" | "fitHint"
>[] = [
  {
    id: "qwen3.5:35b",
    label: "Qwen 3.5 35B (MoE)",
    blurb: "Best all-round local agent — strong tool calling",
    downloadGb: 21,
    minRamGb: 32,
  },
  {
    id: "glm-4.7-flash",
    label: "GLM-4.7 Flash",
    blurb: "Fast MoE tuned for agent and tool work",
    downloadGb: 18,
    minRamGb: 24,
  },
  {
    id: "gpt-oss:20b",
    label: "GPT-OSS 20B",
    blurb: "OpenAI's open model — solid reasoning on mid-range Macs",
    downloadGb: 14,
    minRamGb: 16,
  },
  {
    id: "qwen3:8b",
    label: "Qwen 3 8B",
    blurb: "Light and quick — summaries and simple asks",
    downloadGb: 5.2,
    minRamGb: 12,
  },
];

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Fit verdict for an arbitrary installed model, from its size on disk (which
 *  approximates the memory its weights need). macOS only lets the GPU address
 *  part of unified memory, and a run needs context/KV headroom on top — hence
 *  the conservative thresholds. */
export function installedFit(
  sizeGb: number,
  ramGb: number,
): { fit: LocalModelFit; fitHint: string } {
  const needsGb = sizeGb + 1.5; // weights + context/KV headroom
  if (needsGb <= ramGb * 0.55)
    return { fit: "good", fitHint: "runs well on this Mac" };
  if (needsGb <= ramGb * 0.8)
    return { fit: "tight", fitHint: "fits — close other heavy apps" };
  return {
    fit: "too-big",
    fitHint: `needs a ~${Math.ceil(needsGb / 0.8 / 8) * 8} GB Mac — likely too slow here`,
  };
}

/** Fit verdict for a curated model, from its vendor-stated RAM floor. */
export function recommendedFit(
  minRamGb: number,
  ramGb: number,
): { fit: LocalModelFit; fitHint: string } {
  if (ramGb >= minRamGb * 1.5)
    return { fit: "good", fitHint: "runs well on this Mac" };
  if (ramGb >= minRamGb)
    return { fit: "tight", fitHint: "fits — close other heavy apps" };
  return {
    fit: "too-big",
    fitHint: `needs ${minRamGb} GB RAM — this Mac has ${ramGb} GB`,
  };
}

/** Raw entry from Ollama's GET /api/tags. */
export type OllamaTag = {
  name: string;
  size?: number;
  details?: { parameter_size?: string };
};

export function buildLocalModels(
  tags: OllamaTag[],
  ramGb: number,
): LocalModel[] {
  return tags.map((t) => {
    const sizeGb = bytesToGb(t.size ?? 0);
    return {
      id: t.name,
      sizeGb,
      paramSize: t.details?.parameter_size,
      ...installedFit(sizeGb, ramGb),
    };
  });
}

export function buildRecommended(
  installedIds: string[],
  ramGb: number,
): RecommendedModel[] {
  return RECOMMENDED_MODELS.map((r) => ({
    ...r,
    // "qwen3:8b" matches both an exact tag and its latest/quant variants
    installed: installedIds.some(
      (id) =>
        id === r.id || id.startsWith(`${r.id}-`) || id.startsWith(`${r.id}:`),
    ),
    ...recommendedFit(r.minRamGb, ramGb),
  }));
}

/** One parsed line of the streamed /api/pull response → a progress update, or
 *  null when it adds nothing worth forwarding over IPC. */
export function pullProgress(
  line: { status?: string; error?: string; total?: number; completed?: number },
  lastPercent: number,
): { status: string; percent?: number } | null {
  if (line.error) throw new Error(line.error);
  if (line.total && line.completed !== undefined) {
    const percent = Math.floor((line.completed / line.total) * 100);
    if (percent === lastPercent) return null; // throttle: whole percents only
    return { status: line.status ?? "downloading", percent };
  }
  return line.status ? { status: line.status } : null;
}

export class OllamaService {
  private pulling: string | null = null;

  isInstalled(): boolean {
    return (
      fs.existsSync(APP_PATH) || BIN_CANDIDATES.some((p) => fs.existsSync(p))
    );
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Launch the server: the app when present (it owns the menu-bar daemon),
   *  otherwise a detached `ollama serve` for Homebrew-only installs. */
  private launch(): void {
    if (fs.existsSync(APP_PATH)) {
      Bun.spawn(["open", "-a", "Ollama"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    }
    const bin = BIN_CANDIDATES.find((p) => fs.existsSync(p));
    if (!bin) throw new Error("Ollama isn't installed.");
    Bun.spawn([bin, "serve"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  /** Make sure the server answers, starting it if needed. Used as the
   *  local auth strategy's pre-run hook, so it must be quick when healthy. */
  async ensureRunning(): Promise<void> {
    if (await this.ping()) return;
    if (!this.isInstalled()) {
      throw new Error(
        "Ollama isn't installed. Set it up in Settings → Providers → Ollama.",
      );
    }
    this.launch();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.ping()) return;
    }
    throw new Error(
      "Ollama didn't start in time — try launching the Ollama app manually.",
    );
  }

  private async listTags(): Promise<OllamaTag[]> {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Ollama /api/tags failed (${res.status})`);
    const data = (await res.json()) as { models?: OllamaTag[] };
    return data.models ?? [];
  }

  async status(): Promise<OllamaStatus> {
    const running = await this.ping();
    const ramGb = Math.round(os.totalmem() / 1024 ** 3);
    let models: LocalModel[] = [];
    if (running) {
      try {
        models = buildLocalModels(await this.listTags(), ramGb);
      } catch {
        // server up but tags unreadable — treat as no models rather than fail
      }
    }
    return {
      // a running server counts as installed even if we can't see the binary
      installed: this.isInstalled() || running,
      running,
      totalRamGb: ramGb,
      models,
      recommended: buildRecommended(
        models.map((m) => m.id),
        ramGb,
      ),
    };
  }

  /** Download a model, streaming whole-percent progress. One at a time —
   *  parallel pulls would just fight over bandwidth and disk. */
  async pull(
    model: string,
    onProgress: (p: { status: string; percent?: number }) => void,
  ): Promise<void> {
    if (this.pulling)
      throw new Error(
        `Already downloading ${this.pulling} — wait for it to finish.`,
      );
    this.pulling = model;
    try {
      await this.ensureRunning();
      const res = await fetch(`${OLLAMA_URL}/api/pull`, {
        method: "POST",
        body: JSON.stringify({ model, stream: true }),
      });
      if (!res.ok || !res.body)
        throw new Error(`Download failed to start (HTTP ${res.status}).`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastPercent = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const update = pullProgress(JSON.parse(raw), lastPercent);
          if (!update) continue;
          if (update.percent !== undefined) lastPercent = update.percent;
          onProgress(update);
        }
      }
    } finally {
      this.pulling = null;
    }
  }
}
