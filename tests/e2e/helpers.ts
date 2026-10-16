import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

/**
 * The app directory. package.json's main points at dist/main.js, so this is the
 * same thing the nix wrapper hands Electron.
 */
export const appDir = path.resolve(__dirname, "..", "..");

/**
 * Whether the tests are running as root, which is what the GitLab job does: the
 * nix runner's container is alpine as its default user. Chromium refuses to
 * start as root with its sandbox on, so the app is handed --no-sandbox there and
 * nowhere else — an ordinary run drives it exactly as the desktop does.
 */
const runningAsRoot = process.getuid?.() === 0;

/**
 * The Electron to drive. An explicit DSH_ELECTRON wins; otherwise take the first
 * `electron` on PATH that is *not* the devDependency — that package is here for
 * its TypeScript types only and ships no runnable binary, so the one nix
 * provides (`nix shell nixpkgs#electron`) is the one to use.
 */
function electronPath(): string {
  const explicit = process.env.DSH_ELECTRON;
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "" || dir.includes("node_modules")) continue;
    const candidate = path.join(dir, "electron");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "no Electron to drive: set DSH_ELECTRON, or run the tests under `nix shell nixpkgs#electron`",
  );
}

export interface StubService {
  url: string;
  close(): Promise<void>;
}

/** How a stub answers one request: the status to send, and the body to wrap. */
export interface StubReply {
  status?: number;
  body?: string;
}

/**
 * A stand-in for `dsh web`: loopback, one page, whatever path is asked for.
 *
 * A string is served to everyone. A function decides per request, which is how
 * the token test makes the far side refuse an address until the app comes back
 * with the one it mints now.
 */
export async function stubService(
  respond: string | ((url: URL) => StubReply) = "stub harness",
): Promise<StubService> {
  const answer = typeof respond === "string" ? (): StubReply => ({ body: respond }) : respond;
  const server: Server = createServer((request, response) => {
    const { status = 200, body = "stub harness" } = answer(
      new URL(request.url ?? "/", "http://stub"),
    );
    response.writeHead(status, { "content-type": "text/html" });
    response.end(`<!doctype html><title>stub harness</title><body>${body}</body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface Harness {
  app: ElectronApplication;
  /** The client-side titlebar page. */
  titlebar: Page;
  /** The page showing the harness, or the waiting screen. */
  harness: Page;
  userData: string;
  hostsFile: string;
  close(): Promise<void>;
}

/** The app's host list, parsed — undefined until the app has written one. */
export async function hostsFileOf(userData: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(userData, "hosts.json"), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export interface LaunchOptions {
  /** A directory to put in front of PATH — where the tunnel test keeps its ssh. */
  pathPrepend?: string;
  /** Extra environment for the app. */
  env?: Record<string, string>;
  /** The app directory to launch; this checkout's by default. */
  appDir?: string;
}

/**
 * Launch the app the way the desktop does: a throwaway runtime directory the
 * service publishes its URL into, and a throwaway config directory for the host
 * list.
 */
export async function launch(serviceUrl?: string, options: LaunchOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-chrome-"));
  const runtime = path.join(root, "run");
  const userData = path.join(root, "config");
  await mkdir(path.join(runtime, "dsh-web"), { recursive: true, mode: 0o700 });
  await mkdir(userData, { recursive: true });
  if (serviceUrl !== undefined) {
    await writeFile(path.join(runtime, "dsh-web", "url"), `${serviceUrl}\n`, { mode: 0o600 });
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Take the X11 path, so a headless run needs only a display; and point the
  // runtime directory at the throwaway one above.
  delete env.WAYLAND_DISPLAY;
  delete env.NIXOS_OZONE_WL;
  env.XDG_SESSION_TYPE = "x11";
  env.XDG_RUNTIME_DIR = runtime;
  if (options.pathPrepend !== undefined) {
    env.PATH = `${options.pathPrepend}:${env.PATH ?? ""}`;
  }
  Object.assign(env, options.env ?? {});

  const app = await electron.launch({
    executablePath: electronPath(),
    args: [
      options.appDir ?? appDir,
      `--user-data-dir=${userData}`,
      // See runningAsRoot: the CI container is root, and Chromium will not
      // start there any other way. A developer's run keeps its sandbox.
      ...(runningAsRoot ? ["--no-sandbox"] : []),
    ],
    env,
  });

  // Playwright surfaces both WebContentsViews as pages, but the second one's
  // "window" event can fire before a listener is attached, so poll the list
  // rather than race it. The unused webContents behind the two views has no URL
  // and is skipped by requiring one.
  const deadline = Date.now() + 20_000;
  let titlebar: Page | undefined;
  let harness: Page | undefined;
  for (;;) {
    const found = app.windows();
    titlebar = found.find((page) => page.url().includes("titlebar.html"));
    harness = found.find((page) => page.url() !== "" && !page.url().includes("titlebar.html"));
    if (titlebar !== undefined && harness !== undefined) break;
    if (Date.now() > deadline) {
      throw new Error(`no titlebar and harness pages: ${found.map((page) => page.url()).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The bar is only worth driving once its script has filled the combobox in.
  // (Waiting on the DOM rather than evaluating script keeps the pages' CSP
  // intact — they allow no eval, and neither should the tests need it. The
  // options of a closed select have no box, hence attached rather than the
  // default visible.)
  await titlebar.locator("#host option").first().waitFor({ state: "attached", timeout: 15_000 });

  return {
    app,
    titlebar,
    harness,
    userData,
    hostsFile: path.join(userData, "hosts.json"),
    async close() {
      await app.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Open the host dialog from the titlebar, and return its page. */
export async function openSettings(app: ElectronApplication, titlebar: Page): Promise<Page> {
  const opened = app.waitForEvent("window");
  await titlebar.getByTitle("Hosts…").click();
  const dialog = await opened;
  // Rows only appear once the dialog's script has listed the hosts.
  await dialog.locator("#list li").first().waitFor({ timeout: 15_000 });
  return dialog;
}
