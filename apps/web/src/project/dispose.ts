import { useEffect } from "react";

const pending = new WeakMap<object, ReturnType<typeof setTimeout>>();

/**
 * Calls `dispose(resource)` once the component that holds `resource`
 * unmounts for good, or moves on to another one. StrictMode unmounts and
 * mounts again right away with the same state, so the disposal waits a task
 * and that remount cancels it. `dispose` should be stable (module level).
 */
export function useDisposeOnUnmount<T extends object>(
  resource: T,
  dispose: (resource: T) => void,
): void {
  useEffect(() => {
    const timer = pending.get(resource);
    if (timer !== undefined) {
      clearTimeout(timer);
      pending.delete(resource);
    }
    return () => {
      pending.set(
        resource,
        setTimeout(() => {
          pending.delete(resource);
          dispose(resource);
        }, 0),
      );
    };
  }, [resource, dispose]);
}
