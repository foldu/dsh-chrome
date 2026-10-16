// The list of harness hosts this app can point at. "local" is this machine's
// dsh web service, reached through the runtime URL file the dsh-web unit
// publishes. Any other entry is either a URL — loaded as it stands — or an SSH
// target, because a remote `dsh web` only ever binds its own loopback: reaching
// one means forwarding that over ssh.
import fs from "node:fs/promises";
import path from "node:path";
import type { HostEntry } from "./ipc";

/** The built-in entry: the harness on this machine. */
export const LOCAL = "local";

/** The persisted list, and which entry is on screen. */
export interface StoredHosts {
  hosts: string[];
  selected: string;
}

/** How a stored entry is reached. */
export type Target =
  | { kind: "local" }
  | { kind: "ssh"; target: string }
  | { kind: "url"; url: string };

/** Whether a value names its own scheme (and so its own endpoint). */
const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

/** Where the list is kept: the app's own config directory. */
export function file(userData: string): string {
  return path.join(userData, "hosts.json");
}

/**
 * Turn what the user typed into the value we store: trimmed, with trailing
 * slashes dropped. A bare hostname stays bare — it is an SSH target, not a URL.
 *
 * @returns the value to store, or null when the input was empty.
 */
export function normalize(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * How the entry is reached. A value naming a scheme is loaded directly (a host
 * behind a reverse proxy, or one carrying its own launch token); everything else
 * is an SSH target.
 */
export function target(value: string): Target {
  if (value === LOCAL) return { kind: "local" };
  return hasScheme(value) ? { kind: "url", url: value } : { kind: "ssh", target: value };
}

/** What the combobox and the dialog show for a stored value. */
export function label(value: string): string {
  if (value === LOCAL) return LOCAL;
  const where = target(value);
  if (where.kind === "url") {
    try {
      return new URL(where.url).host;
    } catch {
      return where.url;
    }
  }
  // An ssh target reads better without its user, which is the same to ssh.
  return value.replace(/^[^@/]+@/, "");
}

/** Read the persisted list, falling back to "just this machine". */
export async function read(userData: string): Promise<StoredHosts> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file(userData), "utf8"));
    const record = parsed as { hosts?: unknown; selected?: unknown };
    const hosts = Array.isArray(record.hosts)
      ? record.hosts.filter((entry): entry is string => typeof entry === "string")
      : [];
    const selected = typeof record.selected === "string" ? record.selected : LOCAL;
    return {
      hosts,
      // A selection that is no longer in the list falls back to local.
      selected: selected === LOCAL || hosts.includes(selected) ? selected : LOCAL,
    };
  } catch {
    return { hosts: [], selected: LOCAL };
  }
}

export async function write(userData: string, state: StoredHosts): Promise<void> {
  const target_ = file(userData);
  await fs.mkdir(path.dirname(target_), { recursive: true });
  // An entry may carry a launch token, so keep the file to its owner.
  await fs.writeFile(target_, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(target_, 0o600).catch(() => {});
}

/** The combobox's contents: this machine first, then the added hosts. */
export function entries(state: StoredHosts): HostEntry[] {
  return [LOCAL, ...state.hosts].map((value) => ({ value, label: label(value) }));
}
