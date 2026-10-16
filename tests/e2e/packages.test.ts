import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { appDir, launch, type Harness } from "./helpers";

/** A 1x1 PNG, enough for the page to load as its mark. */
const MARK =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQkpb5DwAB9QFRwLDKMgAAAABJRU5ErkJggg==";

let harness: Harness | undefined;
let copies: string[] = [];

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const dir of copies) await rm(dir, { recursive: true, force: true });
  copies = [];
});

/**
 * The titlebar's mark is a relative `./icon.png` from the page, so it only loads
 * when the icon sits beside the pages — which is what the nix package installs
 * (default.nix) and what the build copies when a checkout has one. Laid out the
 * way the package is, the mark has to be there and visible.
 */
test("shows the mark when it is installed beside the pages", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-app-"));
  copies.push(dir);
  await cp(path.join(appDir, "dist"), path.join(dir, "dist"), { recursive: true });
  await cp(path.join(appDir, "package.json"), path.join(dir, "package.json"));
  await writeFile(path.join(dir, "dist", "renderer", "icon.png"), Buffer.from(MARK, "base64"));

  harness = await launch(undefined, { appDir: dir });

  await expect
    .poll(() => harness!.titlebar.locator("#mark").isVisible(), { timeout: 15_000 })
    .toBe(true);
  expect(await harness.titlebar.locator("#mark").getAttribute("src")).toBe("icon.png");
});
