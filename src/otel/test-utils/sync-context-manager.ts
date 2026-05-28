import { type Context, type ContextManager, ROOT_CONTEXT } from '@opentelemetry/api';

// A minimal context manager that propagates context synchronously through
// `with()` calls. Real-world Node deployments would use
// @opentelemetry/context-async-hooks for cross-async propagation; this is
// enough for the spike's trace-correlation tests since record() is synchronous.
export class SyncContextManager implements ContextManager {
  private active_: Context = ROOT_CONTEXT;

  active(): Context {
    return this.active_;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.active_;
    this.active_ = context;
    try {
      return fn.call(thisArg as ThisParameterType<F>, ...args);
    } finally {
      this.active_ = previous;
    }
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}
