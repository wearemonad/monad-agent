import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

/** Give a window a real AppKit minimum size (NSWindow.minSize), so macOS
 *  stops the resize drag itself — Electrobun (1.x and 2.x) has no option
 *  for it.
 *
 *  Threading: Electrobun runs our code on a worker thread and does all
 *  AppKit work on the main thread (its own setters wrap every call in
 *  runOnMainThreadAsync). Touching the NSWindow from here would break that
 *  rule, so the only message sent to the window is
 *  `performSelectorOnMainThread:withObject:waitUntilDone:`, which is
 *  documented as callable from any thread. What it runs on the main thread
 *  is `setValuesForKeysWithDictionary: @{ @"minSize": NSValue(size) }` —
 *  KVC unwraps the NSValue and calls `setMinSize:`. The NSValue, key and
 *  dictionary are plain Foundation objects, safe to build off the main
 *  thread; performSelector retains the dictionary until it has run.
 *
 *  Three Bun FFI traps this avoids, each of which crashed or corrupted the
 *  call in testing:
 *  - Object handles travel as u64 (BigInt), never `ptr`: `ptr` values are JS
 *    doubles, and tagged-pointer objects (a short NSString like "minSize")
 *    have high bits a double can't hold exactly.
 *  - objc_msgSend gets its own dlopen binding per call shape: CFunction
 *    reuses one trampoline per address, so differently-typed calls through
 *    it pass their arguments wrong.
 *  - C strings are standalone Uint8Arrays kept referenced until the calls
 *    finish (Buffer.from slices a shared pool).
 *
 *  macOS only; returns false (and changes nothing) anywhere it can't apply. */
export function setWindowMinSize(
  window: Pointer | null,
  width: number,
  height: number,
): boolean {
  if (process.platform !== "darwin" || !window) return false;
  try {
    const id = FFIType.u64;
    const strings: Uint8Array[] = [];
    const cstr = (s: string) => {
      const bytes = new TextEncoder().encode(`${s}\0`);
      strings.push(bytes);
      return ptr(bytes);
    };
    const objc = dlopen(LIBOBJC, {
      objc_getClass: { args: [FFIType.ptr], returns: id },
      sel_registerName: { args: [FFIType.ptr], returns: id },
    });
    const msgSend = (args: FFIType[], returns: FFIType) =>
      dlopen(LIBOBJC, { objc_msgSend: { args, returns } }).symbols
        .objc_msgSend as (...a: unknown[]) => unknown;
    const cls = (name: string) => objc.symbols.objc_getClass(cstr(name));
    const sel = (name: string) => objc.symbols.sel_registerName(cstr(name));

    const win = BigInt(window);
    const performOnMain = sel(
      "performSelectorOnMainThread:withObject:waitUntilDone:",
    );
    // Guard: only an object that answers the selector gets the message.
    if (
      !msgSend([id, id, id], FFIType.bool)(
        win,
        sel("respondsToSelector:"),
        performOnMain,
      )
    )
      return false;

    // NSSize is two doubles — passed in floating-point registers on both
    // arm64 and x86_64, exactly like two double arguments.
    const value = msgSend([id, id, FFIType.f64, FFIType.f64], id)(
      cls("NSValue"),
      sel("valueWithSize:"),
      width,
      height,
    );
    const key = msgSend([id, id, FFIType.ptr], id)(
      cls("NSString"),
      sel("stringWithUTF8String:"),
      cstr("minSize"),
    );
    const dict = msgSend([id, id, id, id], id)(
      cls("NSDictionary"),
      sel("dictionaryWithObject:forKey:"),
      value,
      key,
    );
    if (!value || !key || !dict) return false;

    msgSend([id, id, id, id, FFIType.bool], FFIType.void)(
      win,
      performOnMain,
      sel("setValuesForKeysWithDictionary:"),
      dict,
      false, // async — never block our thread on the main run loop
    );
    strings.length = 0; // every C string has been consumed
    return true;
  } catch (e) {
    console.warn(`[window] min size not applied: ${(e as Error).message}`);
    return false;
  }
}
