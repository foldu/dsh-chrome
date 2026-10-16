import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { launch, openSettings, stubService, type Harness } from "./helpers";

/**
 * A stand-in for ssh. It honours the app's `-L` forward by proxying the local
 * port it is handed to the stub service, recording what it was asked to point at,
 * and answers the URL question the way FAKE_SSH_MODE says: from the runtime file
 * (`file`, the default), or only from the unit's status (`status`).
 *
 * Two markers let a test disturb a forward that is already up, which is how the
 * reconnect tests reach what ssh does when the far side moves under it:
 * FAKE_SSH_URL_FILE is re-read for every answer, so the published token can
 * change; a forward exits when FAKE_SSH_EXIT_FILE appears, standing in for the
 * connection dropping.
 */
const FAKE_SSH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, rmSync } = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const forward = args.indexOf("-L");
const urlFile = process.env.FAKE_SSH_URL_FILE;
const url = urlFile === undefined
  ? (process.env.FAKE_SSH_URL ?? "http://127.0.0.1:3090/?token=fake")
  : readFileSync(urlFile, "utf8").trim();
if (forward !== -1) {
  appendFileSync(process.env.FAKE_SSH_RECORD, args[forward + 1] + "\\n");
  const exitFile = process.env.FAKE_SSH_EXIT_FILE;
  if (exitFile !== undefined) {
    // Consume the marker before dying, so the forward the app builds next is
    // not killed by the same one.
    const timer = setInterval(() => {
      if (!existsSync(exitFile)) return;
      rmSync(exitFile, { force: true });
      clearInterval(timer);
      process.exit(0);
    }, 25);
  }
  const port = Number(args[forward + 1].split(":")[0]);
  const target = Number(process.env.FAKE_SSH_TARGET_PORT);
  net
    .createServer((from) => {
      const to = net.connect(target, "127.0.0.1");
      from.pipe(to).pipe(from);
      from.on("error", () => to.destroy());
      to.on("error", () => from.destroy());
    })
    .listen(port, "127.0.0.1");
} else if (process.env.FAKE_SSH_MODE === "status" && args.join(" ").includes("systemctl")) {
  process.stdout.write("● dsh-web.service - DeepSeek Harness web GUI server\\n");
  process.stdout.write("     Active: active (running) since Fri 2026-10-09 22:00:00 CEST; 1s ago\\n");
  process.stdout.write("Oct 09 22:00:00 host dsh-web[1]: dsh web: " + url + "\\n");
} else if (process.env.FAKE_SSH_MODE === "status") {
  process.exit(1);
} else {
  process.stdout.write(url + "\\n");
}
`;

let harness: Harness | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

/** A directory holding the fake ssh, plus the file it records forwards in. */
async function fakeSsh(): Promise<{ dir: string; record: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-fake-ssh-"));
  const record = path.join(dir, "forwards");
  await writeFile(path.join(dir, "ssh"), FAKE_SSH, { mode: 0o755 });
  return { dir, record };
}

/** Add `entry` through the settings dialog and switch the combobox to it. */
async function addAndSelect(app: Harness, entry: string): Promise<void> {
  const dialog = await openSettings(app.app, app.titlebar);
  await dialog.locator("#value").fill(entry);
  await dialog.locator("button[type=submit]").click();
  await expect
    .poll(() => dialog.locator("#list li").count(), { timeout: 15_000 })
    .toBeGreaterThan(1);
  await dialog.locator("#done").click();
  await app.titlebar.locator("#host").selectOption(entry);
}

test("forwards a bare hostname over ssh and loads what the far side publishes", async () => {
  const service = await stubService("tunnelled harness");
  const { dir, record } = await fakeSsh();
  scratch = dir;

  try {
    harness = await launch(undefined, {
      pathPrepend: dir,
      env: {
        FAKE_SSH_TARGET_PORT: new URL(service.url).port,
        FAKE_SSH_RECORD: record,
        FAKE_SSH_URL: "http://127.0.0.1:3090/?token=fake",
      },
    });

    await addAndSelect(harness, "jupiter.home.5kw.li");
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("tunnelled harness");

    // It went through the forward's own port, carrying the far side's token.
    const loaded = new URL(harness.harness.url());
    expect(loaded.hostname).toBe("127.0.0.1");
    expect(loaded.searchParams.get("token")).toBe("fake");
    expect(loaded.port).not.toBe(new URL(service.url).port);

    // And the forward points at the port the far side said it serves on.
    expect((await readFile(record, "utf8")).trim()).toMatch(/:127\.0\.0\.1:3090$/);
  } finally {
    await service.close();
  }
});

test("falls back to the unit's status, and forwards to the port that names", async () => {
  const service = await stubService("status harness");
  const { dir, record } = await fakeSsh();
  scratch = dir;

  try {
    harness = await launch(undefined, {
      pathPrepend: dir,
      env: {
        FAKE_SSH_MODE: "status",
        FAKE_SSH_TARGET_PORT: new URL(service.url).port,
        FAKE_SSH_RECORD: record,
        // A saturn-style deployment serves on 3080, not this repo's 3090.
        FAKE_SSH_URL: "http://127.0.0.1:3080/?token=status",
      },
    });

    await addAndSelect(harness, "saturn.home.5kw.li");
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("status harness");

    const loaded = new URL(harness.harness.url());
    expect(loaded.searchParams.get("token")).toBe("status");
    expect((await readFile(record, "utf8")).trim()).toMatch(/:127\.0\.0\.1:3080$/);
  } finally {
    await service.close();
  }
});

test("says why when the forward cannot come up", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-fake-ssh-"));
  scratch = dir;
  await writeFile(
    path.join(dir, "ssh"),
    `#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 255\n`,
    { mode: 0o755 },
  );

  harness = await launch(undefined, { pathPrepend: dir });
  await addAndSelect(harness, "locked.example");
  await expect
    .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
    .toContain("Permission denied (publickey).");
  expect(await harness.harness.title()).toBe("Cannot reach locked.example");
});

/** The forwards ssh has been asked for, in order — empty before the first one. */
async function forwards(record: string): Promise<string[]> {
  const text = await readFile(record, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "");
}

// Both tests below wait out TUNNEL_RETRY_MS (15s) before the app tries again,
// and that is deliberate: the backoff is part of what is being tested, not an
// accident of the clock to be shortened away.
test("builds a new forward when the ssh connection drops", async () => {
  const service = await stubService("reconnected harness");
  const { dir, record } = await fakeSsh();
  scratch = dir;
  const exitFile = path.join(dir, "drop-the-connection");

  try {
    harness = await launch(undefined, {
      pathPrepend: dir,
      env: {
        FAKE_SSH_TARGET_PORT: new URL(service.url).port,
        FAKE_SSH_RECORD: record,
        FAKE_SSH_EXIT_FILE: exitFile,
        FAKE_SSH_URL: "http://127.0.0.1:3090/?token=first",
      },
    });

    await addAndSelect(harness, "jupiter.home.5kw.li");
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("reconnected harness");
    expect(await forwards(record)).toHaveLength(1);

    // Drop the link the way a network does: the forward goes away underneath a
    // page that has already loaded.
    await writeFile(exitFile, "");

    // ssh's own complaint is what the window says, rather than freezing on a
    // page whose forward is gone.
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("exited with 0");

    // Then it comes back by itself: a second forward, and the harness on screen
    // again, with nothing asked of the user.
    await expect
      .poll(async () => (await forwards(record)).length, { timeout: 60_000 })
      .toBe(2);
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("reconnected harness");
  } finally {
    await service.close();
  }
});

test("re-reads the far side's URL when it refuses a token that went stale", async () => {
  // A far side that only trusts the token it mints: the app's first address
  // carries the old one, which is what a `dsh web` restart looks like from here.
  const service = await stubService((url) =>
    url.searchParams.get("token") === "fresh"
      ? { body: "token refreshed" }
      : { status: 401, body: "stale token" },
  );
  const { dir, record } = await fakeSsh();
  scratch = dir;
  const urlFile = path.join(dir, "published-url");
  await writeFile(urlFile, "http://127.0.0.1:3090/?token=stale\n");

  try {
    harness = await launch(undefined, {
      pathPrepend: dir,
      env: {
        FAKE_SSH_TARGET_PORT: new URL(service.url).port,
        FAKE_SSH_RECORD: record,
        FAKE_SSH_URL_FILE: urlFile,
      },
    });

    await addAndSelect(harness, "saturn.home.5kw.li");

    // The forward came up, the load was refused, and the window says so. This
    // is where the old behaviour stopped: the session stayed, so the loop saw a
    // URL it believed was on screen and never tried anything again.
    await expect.poll(async () => (await forwards(record)).length, { timeout: 30_000 }).toBe(1);
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("needs this app's launch token");

    // The far side has restarted, and publishes a different token.
    await writeFile(urlFile, "http://127.0.0.1:3090/?token=fresh\n");

    // The app asks again, rather than reloading the address it already has.
    await expect
      .poll(async () => (await forwards(record)).length, { timeout: 60_000 })
      .toBe(2);
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 30_000 })
      .toContain("token refreshed");
    expect(new URL(harness.harness.url()).searchParams.get("token")).toBe("fresh");
  } finally {
    await service.close();
  }
});
