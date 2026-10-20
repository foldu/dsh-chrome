import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_PORT,
  SshFailure,
  classify,
  freePort,
  localize,
  portOpen,
  publishedPort,
  remoteArgs,
  remoteServiceUrl,
  sshArgs,
  sshMessage,
  statusRunning,
  urlFrom,
  urlSources,
} from "../../src/tunnel";

/** The value that follows a flag in an argv. */
function after(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe("sshArgs", () => {
  it("forwards a local port to the far side's service port", () => {
    expect(after(sshArgs("jupiter.home.5kw.li", 51000), "-L")).toBe(`51000:127.0.0.1:${REMOTE_PORT}`);
    expect(sshArgs("jupiter.home.5kw.li", 51000).at(-1)).toBe("jupiter.home.5kw.li");
  });

  it("takes the remote port from the caller when one is given", () => {
    expect(after(sshArgs("host", 1, 3080), "-L")).toBe("1:127.0.0.1:3080");
  });

  it("runs no command, asks for no prompt, and fails rather than hanging", () => {
    const args = sshArgs("host", 1);
    expect(args).toContain("-N");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ConnectTimeout=10");
  });
});

describe("remoteArgs", () => {
  it("runs the command on the far side, without a prompt", () => {
    const args = remoteArgs("host", "true");
    expect(args.at(-1)).toBe("true");
    expect(args.at(-2)).toBe("host");
    expect(args).toContain("BatchMode=yes");
  });
});

describe("urlSources", () => {
  it("asks for the runtime file first, which needs no running check", () => {
    const [first] = urlSources();
    expect(first?.command).toContain("dsh-web/url");
    expect(first?.command).toContain("XDG_RUNTIME_DIR");
    expect(first?.requiresRunning).toBeUndefined();
  });

  it("then reads a user unit's status, then a system one's", () => {
    const [, user, system] = urlSources();
    expect(user?.command).toBe("systemctl --user status --output=cat --lines=50 --no-pager dsh-web");
    expect(user?.requiresRunning).toBe(true);
    expect(system?.command).toBe("systemctl status --output=cat --lines=50 --no-pager dsh");
    expect(system?.requiresRunning).toBe(true);
  });
});

describe("statusRunning", () => {
  const block = (active: string): string =>
    [
      "● dsh-web.service - DeepSeek Harness web GUI server",
      `     Active: ${active}`,
      "   Main PID: 1234 (dsh)",
    ].join("\n");

  it("accepts a unit that is up", () => {
    expect(
      statusRunning(block("active (running) since Fri 2026-10-09 22:00:00 CEST; 2min ago")),
    ).toBe(true);
  });

  it("rejects one that stopped or failed, whose URL is a dead token", () => {
    expect(
      statusRunning(block("inactive (dead) since Fri 2026-10-09 22:01:00 CEST; 1min ago")),
    ).toBe(false);
    expect(
      statusRunning(block("failed (Result: exit-code) since Fri 2026-10-09 22:01:00 CEST")),
    ).toBe(false);
  });
});

describe("urlFrom", () => {
  it("takes the announcement out of a status block", () => {
    const output = [
      "● dsh-web.service - DeepSeek Harness web GUI server",
      "     Active: active (running) since Fri 2026-10-09 22:00:00 CEST; 2min ago",
      "",
      "Oct 09 22:00:00 host dsh-web[1234]: dsh web: http://127.0.0.1:3090/?token=abc",
    ].join("\n");
    expect(urlFrom(output)).toBe("http://127.0.0.1:3090/?token=abc");
  });

  it("prefers the newest when a restart printed more than one", () => {
    const output = [
      "dsh web: http://127.0.0.1:3090/?token=old",
      "dsh web: http://127.0.0.1:3090/?token=new",
    ].join("\n");
    expect(urlFrom(output)).toBe("http://127.0.0.1:3090/?token=new");
  });

  it("takes the runtime file's content, which is just the URL", () => {
    expect(urlFrom("http://127.0.0.1:3090/?token=abc\n")).toBe("http://127.0.0.1:3090/?token=abc");
  });

  it("is null when nothing URL-shaped was printed", () => {
    expect(urlFrom("Active: inactive (dead)")).toBeNull();
    expect(urlFrom("")).toBeNull();
  });
});

describe("publishedPort", () => {
  it("is the port the far side says it serves on, which the forward targets", () => {
    expect(publishedPort("http://127.0.0.1:3080/?token=x")).toBe(3080);
    expect(publishedPort("https://dsh.example:9443/?token=x")).toBe(9443);
  });

  it("is null without a URL, or without an explicit port", () => {
    expect(publishedPort(null)).toBeNull();
    expect(publishedPort("http://127.0.0.1/?token=x")).toBeNull();
    expect(publishedPort("not a url")).toBeNull();
  });
});

describe("localize", () => {
  it("moves a published URL onto the tunnel's port, token and all", () => {
    expect(localize("http://127.0.0.1:3090/?token=abc123", 51000)).toBe(
      "http://127.0.0.1:51000/?token=abc123",
    );
  });

  it("drops to http, because the forward speaks plain http to that listener", () => {
    expect(localize("https://dsh.home.5kw.li/?token=x", 4)).toBe("http://127.0.0.1:4/?token=x");
  });

  it("keeps a path", () => {
    expect(localize("http://127.0.0.1:3090/prefix/?token=x", 4)).toBe(
      "http://127.0.0.1:4/prefix/?token=x",
    );
  });
});

describe("classify", () => {
  it("calls a refused key auth, which no other source can fix", () => {
    expect(classify("barnabas@host: Permission denied (publickey).\n")).toBe("auth");
    expect(classify("Received disconnect: Too many authentication failures")).toBe("auth");
    expect(classify("Host key verification failed.")).toBe("auth");
  });

  it("calls a connection that cannot be made transport", () => {
    expect(classify("ssh: connect to host h port 22: Connection refused")).toBe("transport");
    expect(classify("kex_exchange_identification: read: Connection reset by peer")).toBe(
      "transport",
    );
    expect(classify("ssh: Could not resolve hostname nope: Name or service not known")).toBe(
      "transport",
    );
  });

  it("leaves a command that ran and said nothing as remote, so the next source is tried", () => {
    expect(classify("cat: /run/user/1000/dsh-web/url: No such file or directory")).toBe("remote");
    expect(classify("Unit dsh-web.service could not be found.")).toBe("remote");
    expect(classify("")).toBe("remote");
  });
});

describe("sshMessage", () => {
  it("drops the warning a pinned public key produces, keeping the real failure", () => {
    const stderr = [
      'Load key "/home/barnabas/.ssh/pubkeys/home.pub": invalid format',
      "barnabas@jupiter.home.5kw.li: Permission denied (publickey).",
    ].join("\n");
    expect(sshMessage(stderr, "fallback")).toBe(
      "barnabas@jupiter.home.5kw.li: Permission denied (publickey).",
    );
  });

  it("still reports a private key that really is malformed", () => {
    // Only the .pub form is the documented pinning trick; anything else is a
    // broken key worth showing.
    expect(sshMessage('Load key "/home/barnabas/.ssh/home": invalid format', "fallback")).toBe(
      'Load key "/home/barnabas/.ssh/home": invalid format',
    );
  });

  it("is the fallback when ssh said nothing", () => {
    expect(sshMessage("  \n", "ssh host exited with 255")).toBe("ssh host exited with 255");
  });
});

describe("remoteServiceUrl", () => {
  /** A stand-in ssh that records each invocation and answers as told. */
  async function fakeSsh(
    script: string | ((paths: { dir: string; log: string }) => string),
  ): Promise<{ dir: string; log: string; ssh: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-ssh-"));
    const log = path.join(dir, "invocations");
    const ssh = path.join(dir, "ssh");
    const body = typeof script === "string" ? script : script({ dir, log });
    await writeFile(ssh, `#!/bin/sh\necho "$@" >> "${log}"\n${body}\n`, { mode: 0o755 });
    return { dir, log, ssh };
  }

  async function invocations(log: string): Promise<string[]> {
    const text = await readFile(log, "utf8").catch(() => "");
    return text.split("\n").filter((line) => line !== "");
  }

  it("stops at the first refused key instead of offering it from every source", async () => {
    const { ssh, log } = await fakeSsh(
      'echo "barnabas@host: Permission denied (publickey)." >&2\nexit 255',
    );

    await expect(remoteServiceUrl("host", ssh)).rejects.toMatchObject({
      kind: "auth",
      message: "barnabas@host: Permission denied (publickey).",
    });
    // The other two sources, and the forward, would fail exactly the same way —
    // and each is another failed authentication the far side penalises.
    expect(await invocations(log)).toHaveLength(1);
  });

  it("tries the next source when one channel simply has nothing to say", async () => {
    // The first invocation is a source that has no URL to give (no runtime file);
    // the second answers. The log has already recorded the invocation by then.
    const { ssh, log } = await fakeSsh(
      ({ log }) => `if [ "$(grep -c '' "${log}")" -le 1 ]; then
  echo "cat: no such file or directory" >&2
  exit 1
fi
echo "● dsh-web.service - DeepSeek Harness web GUI server"
echo "     Active: active (running) since Fri 2026-10-09 22:00:00 CEST; 1s ago"
echo "Oct 09 22:00:00 host dsh-web[1]: dsh web: http://127.0.0.1:3090/?token=abc"`,
    );

    await expect(remoteServiceUrl("host", ssh)).resolves.toBe("http://127.0.0.1:3090/?token=abc");
    expect(await invocations(log)).toHaveLength(2);
  });

  it("does not retry a transport failure from a different source either", async () => {
    const { ssh, log } = await fakeSsh(
      'echo "ssh: connect to host host port 22: Connection refused" >&2\nexit 255',
    );

    await expect(remoteServiceUrl("host", ssh)).rejects.toBeInstanceOf(SshFailure);
    expect(await invocations(log)).toHaveLength(1);
  });
});

describe("ports", () => {
  it("hands out a loopback port nothing is listening on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
    expect(await portOpen(port)).toBe(false);
  });

  it("sees a listener once there is one", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(await portOpen(port)).toBe(true);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});
