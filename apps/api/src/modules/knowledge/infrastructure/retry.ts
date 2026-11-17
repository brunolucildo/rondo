export interface RetryPolicy {
  /** Total tries, the first included. */
  attempts: number;
  /** Wait before the second try, the third... (growing). The last value repeats if needed. */
  backoffMs: readonly number[];
}

/** A typed failure that says whether another try can help and can record how many were made. */
export interface RetryableError extends Error {
  readonly retryable: boolean;
  withAttempts(attempts: number): RetryableError;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `run` up to `policy.attempts` times, waiting longer between tries, while the failure,
 * mapped by `toTyped`, is retryable. Gives up with the typed error carrying the attempt count.
 * `wait` is injectable so tests do not sleep.
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  toTyped: (error: unknown) => RetryableError,
  policy: RetryPolicy,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      const typed = toTyped(error);

      if (attempt >= policy.attempts || !typed.retryable) {
        throw typed.withAttempts(attempt);
      }

      await wait(policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0);
    }
  }
}

/** Rejects with `onTimeout()` if `promise` has not settled in `ms`. The timer never keeps the process alive. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
