import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { launch, stubService, type Harness } from "./helpers";

// A file of its own: after another window has come and gone in the same process
// (the settings dialog, or closing the window from the bar), Playwright's Electron
// support stops attaching a page for the second WebContentsView. The app is fine
// in that state — its own webContents list has the URL — so a fresh process is the
// cheap way around it.
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("hands a desktop link to the OS handler instead of navigating to it", async () => {
  // The shape an agent's output takes when it offers a remote project in the
  // local editor: a scheme no web view can serve.
  const link = "zed://ssh/jupiter.home.5kw.li/home/barnabas/src/foo";
  const service = await stubService(`<a id="open" href="${link}">open in zed</a>`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-open-"));
  const log = path.join(dir, "opened");
  await writeFile(path.join(dir, "xdg-open"), `#!/bin/sh\necho "$@" >> "${log}"\n`, {
    mode: 0o755,
  });

  try {
    harness = await launch(service.url, { pathPrepend: dir });
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 15_000 })
      .toContain("open in zed");
    const before = harness.harness.url();

    // noWaitAfter: the navigation this link starts is cancelled by the app, so
    // Playwright would otherwise sit waiting for one that never completes.
    await harness.harness.click("#open", { noWaitAfter: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // The view did not follow it: a zed:// page would have failed to load and
    // left the harness on an error page.
    expect(harness.harness.url()).toBe(before);
    // ...and the URL went to the desktop's handler.
    await expect
      .poll(() => readFile(log, "utf8").catch(() => ""), { timeout: 10_000 })
      .toContain(link);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
