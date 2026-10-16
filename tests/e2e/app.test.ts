import { afterEach, expect, test } from "vitest";
import { hostsFileOf, launch, openSettings, stubService, type Harness } from "./helpers";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("shows what the local service serves, under the bar this app draws", async () => {
  const service = await stubService("stub harness");
  try {
    harness = await launch(service.url);

    // The attach loop picked the runtime URL file up and loaded it.
    await expect
      .poll(() => harness!.harness.textContent("body"), { timeout: 15_000 })
      .toContain("stub harness");

    // The bar owns the top strip and the harness page sits below it.
    const bounds = await harness.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window?.contentView.children.map((view) => view.getBounds());
    });
    expect(bounds).toHaveLength(2);
    expect(bounds?.[0]).toMatchObject({ x: 0, y: 0, height: 36 });
    expect(bounds?.[1]).toMatchObject({ x: 0, y: 36 });
    expect(bounds?.[1]?.width).toBe(bounds?.[0]?.width);

    // The bar carries this machine as the default entry and its own controls.
    await expect
      .poll(() => harness!.titlebar.locator("#host").inputValue(), { timeout: 15_000 })
      .toBe("local");
    expect(await harness.titlebar.locator("#settings").isVisible()).toBe(true);
    expect(await harness.titlebar.locator("#minimize").isVisible()).toBe(true);
    expect(await harness.titlebar.locator("#maximize").isVisible()).toBe(true);
    expect(await harness.titlebar.locator("#close").isVisible()).toBe(true);

    // A source checkout has no generated mark, and the page hides it rather than
    // showing a broken image; packages.test.ts covers the other case.
    await expect.poll(() => harness!.titlebar.locator("#mark").isVisible(), { timeout: 15_000 }).toBe(false);
  } finally {
    await service.close();
  }
});

test("adds a host in the settings dialog, then switches to it", async () => {
  harness = await launch(); // no service: the window starts on the waiting screen

  const dialog = await openSettings(harness.app, harness.titlebar);
  // A URL entry, so this stays about the list and the combobox; a bare hostname
  // would be an ssh target, which tunnel.test.ts covers. Nothing listens on that
  // port, so the load fails at once and the waiting screen names the host.
  await dialog.locator("#value").fill("http://127.0.0.1:9");
  await dialog.locator("button[type=submit]").click();
  await expect
    .poll(() => dialog.locator("#list li span").allTextContents(), { timeout: 15_000 })
    .toContain("127.0.0.1:9");
  await dialog.locator("#done").click();

  // The combobox learned about it, and switching moves the harness page over.
  await harness.titlebar.locator("#host").selectOption("http://127.0.0.1:9");
  await expect
    .poll(() => harness!.harness.title(), { timeout: 15_000 })
    .toBe("Waiting for 127.0.0.1:9");
  await expect
    .poll(() => hostsFileOf(harness!.userData), { timeout: 15_000 })
    .toMatchObject({ hosts: ["http://127.0.0.1:9"], selected: "http://127.0.0.1:9" });
});

test("closes the window from the bar", async () => {
  harness = await launch();
  const closed = harness.app.waitForEvent("close");
  await harness.titlebar.getByTitle("Close").click();
  await closed;
});
