import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL, entries, file, label, normalize, read, target, write } from "../../src/hosts";

describe("normalize", () => {
  it("keeps a bare hostname bare: it is an ssh target, not a URL", () => {
    expect(normalize("jupiter.home.5kw.li")).toBe("jupiter.home.5kw.li");
    expect(normalize("barnabas@jupiter.home.5kw.li")).toBe("barnabas@jupiter.home.5kw.li");
  });

  it("keeps a URL as written, scheme and token included", () => {
    expect(normalize("https://dsh.home.5kw.li/?token=abc123")).toBe("https://dsh.home.5kw.li/?token=abc123");
    expect(normalize("http://127.0.0.1:8071")).toBe("http://127.0.0.1:8071");
  });

  it("trims around the value and trailing slashes off it", () => {
    expect(normalize("  host.example/  ")).toBe("host.example");
    expect(normalize("https://host.example///")).toBe("https://host.example");
  });

  it("rejects what is not a host at all", () => {
    expect(normalize("")).toBeNull();
    expect(normalize("   ")).toBeNull();
    expect(normalize("/")).toBeNull();
  });
});

describe("target", () => {
  it("is this machine for local", () => {
    expect(target(LOCAL)).toEqual({ kind: "local" });
  });

  it("is an ssh target for a bare host, which is how a remote harness is reached", () => {
    expect(target("jupiter.home.5kw.li")).toEqual({ kind: "ssh", target: "jupiter.home.5kw.li" });
    expect(target("barnabas@saturn")).toEqual({ kind: "ssh", target: "barnabas@saturn" });
  });

  it("is a URL when the value names a scheme", () => {
    expect(target("https://dsh.home.5kw.li/?token=x")).toEqual({
      kind: "url",
      url: "https://dsh.home.5kw.li/?token=x",
    });
  });
});

describe("label", () => {
  it("is the word local for this machine", () => {
    expect(label(LOCAL)).toBe("local");
  });

  it("is the host (with its port) for a URL, never the token", () => {
    expect(label("https://dsh.home.5kw.li/?token=abc123")).toBe("dsh.home.5kw.li");
    expect(label("http://127.0.0.1:8071")).toBe("127.0.0.1:8071");
  });

  it("drops the user from an ssh target, which reads the same to ssh", () => {
    expect(label("barnabas@jupiter.home.5kw.li")).toBe("jupiter.home.5kw.li");
    expect(label("jupiter.home.5kw.li")).toBe("jupiter.home.5kw.li");
  });
});

describe("entries", () => {
  it("puts this machine first, then the added hosts", () => {
    expect(entries({ hosts: ["jupiter.home.5kw.li"], selected: LOCAL })).toEqual([
      { value: LOCAL, label: "local" },
      { value: "jupiter.home.5kw.li", label: "jupiter.home.5kw.li" },
    ]);
  });
});

describe("the stored list", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dsh-hosts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips hosts and the selection", async () => {
    const state = { hosts: ["jupiter.home.5kw.li", "http://b.example:1"], selected: "http://b.example:1" };
    await write(dir, state);
    expect(await read(dir)).toEqual(state);
  });

  it("keeps the file to its owner, since an entry may carry a token", async () => {
    await write(dir, { hosts: ["https://a.example/?token=secret"], selected: LOCAL });
    const mode = (await stat(file(dir))).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("falls back to just this machine when there is no usable file", async () => {
    expect(await read(dir)).toEqual({ hosts: [], selected: LOCAL });

    await writeFile(file(dir), "{ not json", { mode: 0o600 });
    expect(await read(dir)).toEqual({ hosts: [], selected: LOCAL });
  });

  it("falls back to local when the remembered selection is gone", async () => {
    await writeFile(
      file(dir),
      JSON.stringify({ hosts: ["jupiter.home.5kw.li"], selected: "https://dropped.example" }),
      { mode: 0o600 },
    );
    expect(await read(dir)).toEqual({ hosts: ["jupiter.home.5kw.li"], selected: LOCAL });
  });

  it("drops entries that are not strings", async () => {
    await writeFile(file(dir), JSON.stringify({ hosts: ["jupiter.home.5kw.li", 7, null] }), {
      mode: 0o600,
    });
    expect((await read(dir)).hosts).toEqual(["jupiter.home.5kw.li"]);
  });
});
