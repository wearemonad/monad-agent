/** Test helper (like sessionFixtures): a fake SDK message stream a test
 *  feeds message by message, for driving one-shot runs without a CLI.
 *  `aborted` reports whether the run's signal fired (the SDK would kill
 *  its CLI process). */
export function fakeStream<Msg extends { type: string }>() {
  const queue: Msg[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: unknown = null;
  let signal: AbortSignal | undefined;
  const iterable: AsyncIterable<Msg> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift() as Msg;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  const poke = () => {
    wake?.();
    wake = null;
  };
  return {
    open: (s: AbortSignal) => {
      signal = s;
      return iterable;
    },
    push: (m: Msg) => {
      queue.push(m);
      poke();
    },
    end: () => {
      done = true;
      poke();
    },
    fail: (e: unknown) => {
      failure = e;
      poke();
    },
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
}
