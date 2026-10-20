// The SSH port-forward that reaches a remote harness. `dsh web` only ever binds
// the remote loopback (see nixos/saturn/dsh.nix), so the way in is `ssh -L`:
// forward a free local port to the service's port on the far side, then load that
// address in the harness view. What the far side says about itself — through the
// runtime file this repo's unit writes, or through its unit's status — supplies
// both the token and the port to point the forward at.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The port this repo's `dsh-web` unit serves on, when nothing says otherwise. */
export const REMOTE_PORT = 3090;

/** How a service announces its URL on stdout — and so in its unit's log. */
const ANNOUNCE = "dsh web: ";

/** The runtime file this repo's own dsh-web unit publishes its URL in. */
const REMOTE_URL_FILE = '${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/dsh-web/url';

/** Options every ssh call here shares: no prompt, and quick to give up. */
const COMMON_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
];

/** One way of asking the far side for its URL. */
export interface UrlSource {
  /** The command to run over ssh. */
  command: string;
  /**
   * Whether its status block has to say the unit is running first: a unit that
   * has stopped still shows the last URL it printed, whose token is dead.
   */
  requiresRunning?: boolean;
}

/**
 * How to ask the far side for its URL, in the order worth trying: the runtime
 * file this repo's `dsh-web` unit writes (exact, owner-only, and removed when the
 * unit stops); then `systemctl status` of a user unit by that name; then of a
 * system unit called `dsh`, which is how saturn-style deployments run one.
 *
 * `status` rather than `journalctl` on purpose: it prints only the recent tail,
 * and its block is where the running check comes from.
 */
export function urlSources(): UrlSource[] {
  return [
    { command: `cat "${REMOTE_URL_FILE}" 2>/dev/null` },
    {
      command: "systemctl --user status --output=cat --lines=50 --no-pager dsh-web",
      requiresRunning: true,
    },
    {
      command: "systemctl status --output=cat --lines=50 --no-pager dsh",
      requiresRunning: true,
    },
  ];
}

/** Whether a `systemctl status` block says the unit is up and running. */
export function statusRunning(output: string): boolean {
  return output.split("\n").some((line) => /^\s*Active:\s+active \(running\)/.test(line));
}

/** The ssh invocation that carries the forward: no command, and fail loudly if
    the local end cannot be bound. */
export function sshArgs(target: string, localPort: number, remotePort = REMOTE_PORT): string[] {
  return [
    ...COMMON_ARGS,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    target,
  ];
}

/** The ssh invocation for one command run on the far side. */
export function remoteArgs(target: string, command: string): string[] {
  return [...COMMON_ARGS, target, command];
}

/** Whether a line really is a harness URL, rather than merely URL-shaped. */
function isHarnessUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && URL.canParse(value);
}

/**
 * A published URL, from whatever a command printed: a `dsh web: <url>` line out
 * of a unit's log, or the whole output when that is the runtime file's single
 * URL. The newest announcement wins.
 */
export function urlFrom(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // Newest last, and a status block's log lines arrive prefixed with their
  // timestamp and unit ("Oct 09 22:00:00 host dsh-web[1]: dsh web: http://…"), so
  // look for the announcement anywhere in the line.
  for (const line of lines.slice().reverse()) {
    const at = line.lastIndexOf(ANNOUNCE);
    if (at === -1) continue;
    const url = line.slice(at + ANNOUNCE.length).trim();
    if (isHarnessUrl(url)) return url;
  }
  const whole = lines.length === 1 ? lines[0] : undefined;
  return whole !== undefined && isHarnessUrl(whole) ? whole : null;
}

/** The port a published URL listens on: what the forward has to target. */
export function publishedPort(url: string | null): number | null {
  if (url === null) return null;
  try {
    const { port } = new URL(url);
    return port === "" ? null : Number(port);
  } catch {
    return null;
  }
}

/**
 * The far side's authenticated URL, or null when none of the ways of asking turn
 * one up (a host not running this repo's service, say). Each source is its own
 * ssh call, and the first that answers wins.
 */
export async function remoteServiceUrl(target: string, ssh = "ssh"): Promise<string | null> {
  for (const source of urlSources()) {
    try {
      const { stdout } = await run(ssh, remoteArgs(target, source.command), { timeout: 15_000 });
      if (source.requiresRunning === true && !statusRunning(stdout)) continue;
      const url = urlFrom(stdout);
      if (url !== null) return url;
    } catch (error) {
      // A channel with nothing to say is ordinary; a connection that cannot be
      // made is not, and every remaining source would fail the same way.
      const { kind, message } = describeFailure(error, target);
      if (kind !== "remote") throw new SshFailure(kind, message);
    }
  }
  return null;
}

/** A loopback port that nothing is listening on. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

/** Whether something is accepting connections on that loopback port. */
export function portOpen(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** What an ssh failure says about whether trying again differently is worthwhile. */
export type FailureKind = "auth" | "transport" | "remote";

/**
 * Read ssh's complaint for what it means for the rest of the attempt.
 *
 * `auth` and `transport` are properties of the connection itself, so every other
 * URL source — and the forward — would fail the same way. Making those
 * connections anyway is not just wasted work: the far side penalises each failed
 * authentication (OpenSSH's PerSourcePenalties counts 5 s per failure), and a
 * burst of four of them locks the user's own ssh out for half a minute. A
 * `remote` failure is one channel having nothing to say (no runtime file, no unit
 * by that name); the next source may still answer.
 */
export function classify(stderr: string): FailureKind {
  const text = stderr.toLowerCase();
  if (
    /permission denied|too many authentication failures|no supported authentication|host key verification failed|remote host identification has changed/.test(
      text,
    )
  ) {
    return "auth";
  }
  if (
    /could not resolve|connection refused|connection reset|connection timed out|network is unreachable|no route to host|kex_exchange_identification|connection closed by|broken pipe/.test(
      text,
    )
  ) {
    return "transport";
  }
  return "remote";
}

/** An ssh failure the next source cannot fix, carrying what kind it was. */
export class SshFailure extends Error {
  constructor(
    readonly kind: Exclude<FailureKind, "remote">,
    message: string,
  ) {
    super(message);
    this.name = "SshFailure";
  }
}

/**
 * The line worth showing a user. ssh's first line is often a warning: with an
 * IdentityFile that names a public key — the documented way to pin one identity
 * and stop ssh offering every key in the agent — it complains `Load key "…":
 * invalid format` before asking the agent for the matching private key. That line
 * is dropped, and the summary ssh prints last ("Permission denied
 * (publickey).") is what remains.
 */
export function sshMessage(stderr: string, fallback: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const meaningful = lines.filter((line) => !/^Load key ".*\.pub": invalid format$/.test(line));
  return meaningful.at(-1) ?? lines.at(-1) ?? fallback;
}

/** stderr from a failed execFile, as text. */
function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" ? stderr : "";
}

/** Which kind of failure an ssh invocation was, and the line to show for it. */
function describeFailure(error: unknown, target: string): { kind: FailureKind; message: string } {
  const stderr = stderrOf(error);
  // execFile kills a command that outlives its timeout, and that leaves no stderr.
  if (stderr === "" && (error as { killed?: unknown } | null)?.killed === true) {
    return { kind: "transport", message: `ssh ${target} timed out` };
  }
  return { kind: classify(stderr), message: sshMessage(stderr, `ssh ${target} failed`) };
}

/**
 * A sentence about the agent this app's ssh would actually use, for the waiting
 * screen. "Permission denied" has two very different causes — a locked agent, or
 * an agent that is not the one holding the key, since a desktop session usually
 * exports the keyring's socket while the key may live in another agent — and
 * saying which socket was used is the only thing that separates them.
 */
export async function agentSummary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const sock = env.SSH_AUTH_SOCK;
  if (sock === undefined || sock === "") {
    return "This window has no ssh agent (SSH_AUTH_SOCK is unset).";
  }
  try {
    const { stdout } = await run("ssh-add", ["-l"], { timeout: 5_000, env });
    const keys = stdout.split("\n").filter((line) => line.trim() !== "").length;
    return `This window's ssh agent is ${sock}, holding ${keys} key${keys === 1 ? "" : "s"}.`;
  } catch (error) {
    // ssh-add exits 1 when the agent holds nothing, 2 when it cannot be reached.
    const code = (error as { code?: unknown }).code;
    return code === 1
      ? `This window's ssh agent is ${sock}, which holds no keys (locked or empty).`
      : `This window's ssh agent at ${sock} could not be reached.`;
  }
}

export interface Tunnel {
  target: string;
  /** The local port the forward listens on. */
  port: number;
  /** The address to load in the harness view. */
  url: string;
  stop(): void;
}

export interface StartOptions {
  /** The ssh binary; tests point this at a stand-in. */
  ssh?: string;
  /** The far side's service port, which a deployment may have moved. */
  remotePort?: number;
  timeoutMs?: number;
  /** Called if the forward dies after it came up. */
  onExit?: (reason: string) => void;
}

/**
 * Bring a forward up, resolving once the local end accepts connections. Rejects
 * with ssh's own message when it cannot (bad host, no key, port taken).
 */
export async function startTunnel(
  target: string,
  { ssh = "ssh", remotePort = REMOTE_PORT, timeoutMs = 20_000, onExit }: StartOptions = {},
): Promise<Tunnel> {
  const port = await freePort();
  const child: ChildProcess = spawn(ssh, sshArgs(target, port, remotePort), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const failure = (): Error => {
    const message = sshMessage(stderr, `ssh ${target} exited with ${String(child.exitCode)}`);
    const kind = classify(stderr);
    return kind === "remote" ? new Error(message) : new SshFailure(kind, message);
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw failure();
    if (await portOpen(port)) break;
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new SshFailure("transport", sshMessage(stderr, `timed out forwarding to ${target}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  let stopped = false;
  child.once("exit", (code) => {
    if (stopped || onExit === undefined) return;
    onExit(sshMessage(stderr, `ssh ${target} exited with ${String(code)}`));
  });

  return {
    target,
    port,
    url: `http://127.0.0.1:${port}/`,
    stop() {
      stopped = true;
      child.kill("SIGTERM");
      // ssh is quick to go; make sure it does not outlive the app.
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    },
  };
}

/**
 * Point a URL published on the far side at the tunnel's local port, keeping its
 * query — which is where its launch token rides. The token is not bound to an
 * authority, only the cookie it mints is, so this authenticates the first
 * request through the forward.
 */
export function localize(remoteUrl: string, port: number): string {
  const url = new URL(remoteUrl);
  // The forward speaks plain http to the remote's loopback listener, however the
  // far side's own published URL was dressed.
  url.protocol = "http:";
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.toString();
}
