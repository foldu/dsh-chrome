import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  REMOTE_PORT,
  freePort,
  localize,
  portOpen,
  publishedPort,
  remoteArgs,
  sshArgs,
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
