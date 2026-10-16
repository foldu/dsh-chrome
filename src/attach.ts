// When the harness page is (re)loaded, and how impatiently.

/**
 * The local service publishes its URL within a second of starting, so that one
 * is polled every second — it is either about to appear or genuinely down.
 */
export const POLL_MS = 1000;

/**
 * A remote host that is not answering is retried slowly. Retrying every second
 * achieved nothing except a failed navigation a second, and each one took
 * keyboard focus away from the titlebar while the user was reaching for it.
 */
export const REMOTE_RETRY_MS = 15_000;

export interface Attempt {
  /** The URL the selected entry currently resolves to, or null when it has none yet. */
  url: string | null;
  /** The URL the page is showing, or null while it shows the waiting screen. */
  shown: string | null;
  /** Whether the selected entry is this machine's service. */
  local: boolean;
  /** When the last load was attempted. */
  attemptedAt: number;
  now: number;
}

/** Whether this tick should try to load the target at all. */
export function dueForAttempt({ url, shown, local, attemptedAt, now }: Attempt): boolean {
  if (url === null || url === shown) return false;
  return local || now - attemptedAt >= REMOTE_RETRY_MS;
}
