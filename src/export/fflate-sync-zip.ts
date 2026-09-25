/**
 * Worker-free replacement for fflate's asynchronous `zip`, wired in by the Vite and
 * Vitest alias for the bare "fflate" import (see vite.config.ts).
 *
 * write-excel-file always calls `zip()`, and fflate compresses every archive entry of
 * 160 000+ bytes in a `blob:` Web Worker. The application CSP forbids such workers, so a
 * large report would hang. `zipSync` produces the same archive on the calling thread;
 * the callback still arrives asynchronously, as the library expects.
 */
import { zipSync, type AsyncTerminable, type AsyncZipOptions, type AsyncZippable, type FlateCallback, type FlateError, type Zippable } from "fflate/browser";

export * from "fflate/browser";

/** Lets tests prove that the bare "fflate" import resolves to this module. */
export const WORKER_FREE_ZIP = true;

export function zip(data: AsyncZippable, cb: FlateCallback): AsyncTerminable;
export function zip(data: AsyncZippable, opts: AsyncZipOptions, cb: FlateCallback): AsyncTerminable;
export function zip(
  data: AsyncZippable,
  optionsOrCallback: AsyncZipOptions | FlateCallback,
  callback?: FlateCallback
): AsyncTerminable {
  const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
  const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
  if (typeof done !== "function") throw new TypeError("zip() requires a callback");
  let cancelled = false;
  queueMicrotask(() => {
    if (cancelled) return;
    let archive: Uint8Array<ArrayBuffer>;
    try {
      // Async and sync option/file shapes only differ in worker-related flags.
      archive = zipSync(data as Zippable, options);
    } catch (error) {
      done(error as FlateError, null as unknown as Uint8Array<ArrayBuffer>);
      return;
    }
    done(null, archive);
  });
  return () => { cancelled = true; };
}
