import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { fakeStream } from "./fakeSdkStream";
import type { LiveQueryFactory } from "./sdkQuery";

/** Test helper (like fakeSdkStream): fake warm CLI processes for driving
 *  live (interactive) sessions without a CLI. Each query() call spawns one
 *  process that reads the session's input stream like the real SDK does:
 *  it records each user message, and exits when the input ends. Aborting
 *  the process (the SDK's hard kill) fails its stream. */
export function fakeLiveSdk() {
  const processes: FakeProcess[] = [];
  const query: LiveQueryFactory = ({ prompt, options }) => {
    const p = fakeProcess(prompt, options);
    processes.push(p);
    return p.query;
  };
  return { query, processes };
}

export type FakeProcess = ReturnType<typeof fakeProcess>;

function fakeProcess(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options | undefined,
) {
  const out = fakeStream<SDKMessage>();
  const signal = options?.abortController?.signal as AbortSignal;
  const p = {
    options,
    /** User messages the CLI received, in order. */
    inputs: [] as string[],
    /** The session closed its input (graceful exit). */
    inputEnded: false,
    /** A wedged CLI: keeps running after its input closes, until killed. */
    lingers: false,
    models: [] as (string | undefined)[],
    flags: [] as unknown[],
    interrupts: 0,
    /** What interrupt() does: the CLI settles the turn with a result, or
     *  never answers, or the control request fails. */
    onInterrupt: "settle" as "settle" | "hang" | "reject",
    sessionId: "",
    get killed() {
      return signal?.aborted ?? false;
    },
    init(sessionId: string, model = "claude-sonnet-5-5") {
      p.sessionId = sessionId;
      out.push({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model,
      } as unknown as SDKMessage);
    },
    say(text: string) {
      out.push({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: `m-${Math.random()}`,
          role: "assistant",
          content: [{ type: "text", text }],
        },
      } as unknown as SDKMessage);
    },
    /** A streamed text delta (includePartialMessages). */
    delta(text: string) {
      out.push({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      } as unknown as SDKMessage);
    },
    result(extra: Record<string, unknown> = {}) {
      out.push({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done.",
        session_id: p.sessionId,
        num_turns: 1,
        ...extra,
      } as unknown as SDKMessage);
    },
    crash(error: unknown = new Error("CLI exited with code 1")) {
      out.fail(error);
    },
    /** The CLI exits on its own with status 0, mid-whatever. */
    exit() {
      out.end();
    },
    query: undefined as unknown as ReturnType<LiveQueryFactory>,
  };
  signal?.addEventListener(
    "abort",
    () => out.fail(Object.assign(new Error("aborted"), { name: "AbortError" })),
    { once: true },
  );
  // Like the SDK's stdin pump: read the input stream as it arrives.
  void (async () => {
    for await (const m of prompt) {
      const c = m.message.content;
      p.inputs.push(typeof c === "string" ? c : JSON.stringify(c));
    }
    p.inputEnded = true;
    if (!p.lingers) out.end();
  })();
  const stream = out.open(signal);
  p.query = {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    interrupt: async () => {
      p.interrupts++;
      if (p.onInterrupt === "reject") throw new Error("control request failed");
      if (p.onInterrupt === "hang") return new Promise<never>(() => {});
      if (p.onInterrupt === "settle")
        p.result({ subtype: "error_during_execution", is_error: true });
      return undefined;
    },
    setModel: async (model?: string) => {
      p.models.push(model);
    },
    applyFlagSettings: async (settings: unknown) => {
      p.flags.push(settings);
    },
  } as ReturnType<LiveQueryFactory>;
  return p;
}
