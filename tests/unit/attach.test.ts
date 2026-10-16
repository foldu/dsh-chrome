import { describe, expect, it } from "vitest";
import { REMOTE_RETRY_MS, dueForAttempt } from "../../src/attach";

const now = 100_000;
const remote = { url: "https://a.example", shown: null, local: false, attemptedAt: 0, now };

describe("dueForAttempt", () => {
  it("does nothing without a target", () => {
    expect(dueForAttempt({ ...remote, url: null })).toBe(false);
  });

  it("does nothing while the target is already on screen", () => {
    expect(dueForAttempt({ ...remote, shown: remote.url })).toBe(false);
  });

  it("always retries this machine's service, which is either booting or down", () => {
    expect(dueForAttempt({ ...remote, local: true, attemptedAt: now })).toBe(true);
  });

  it("backs off a remote host, so a failure is not a navigation a second", () => {
    expect(dueForAttempt({ ...remote, attemptedAt: now - 1 })).toBe(false);
    expect(dueForAttempt({ ...remote, attemptedAt: now - REMOTE_RETRY_MS + 1 })).toBe(false);
    expect(dueForAttempt({ ...remote, attemptedAt: now - REMOTE_RETRY_MS })).toBe(true);
  });

  it("retries a remote host immediately after a switch, which clears attemptedAt", () => {
    expect(dueForAttempt({ ...remote, attemptedAt: 0, now })).toBe(true);
  });
});
