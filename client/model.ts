/**
 * @deprecated No longer required. The client hydrates Models and plain objects
 * automatically via Proxy; there is no per-type registration to do.
 *
 * This function is retained as a no-op for one release so existing callers
 * keep compiling. The returned value is an identity function over the
 * hydrated object — it simply returns whatever the server sent.
 */
export function createReflectedModel<T = any>(
  _signalProps?: readonly string[],
  _methods?: readonly string[],
): <U = T>(data: U) => U {
  return ((data: any) => data) as any;
}
