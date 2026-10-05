import { lazy, Suspense, type ComponentType, type ReactElement } from "react";

const preloaders: Array<() => Promise<unknown>> = [];

/** Stable component identity keeps editor/terminal state across ordinary renders. */
export function lazyView<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): (props: P) => ReactElement {
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  const preload = () => {
    if (!pending) {
      pending = load().catch((error) => { pending = undefined; throw error; });
    }
    return pending;
  };
  preloaders.push(preload);
  const Component = lazy(preload) as ComponentType<P>;
  return function LazyView(props: P) {
    return (
      <Suspense fallback={<div role="status">loading…</div>}>
        <Component {...props} />
      </Suspense>
    );
  };
}

/** Load one optional module per idle slot after the usable shell has mounted. */
export function preloadOptionalViews(): () => void {
  let cancelled = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const next = () => {
    if (cancelled || index >= preloaders.length) return;
    const run = () => {
      if (cancelled) return;
      void preloaders[index++]().catch(() => {}).finally(next);
    };
    if (typeof window.requestIdleCallback === "function") {
      idle = window.requestIdleCallback(run, { timeout: 3000 });
    } else {
      timer = setTimeout(run, 100);
    }
  };
  timer = setTimeout(next, 1500);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
