// A thin Electron window over a `dsh web` service: this machine's by default, or
// a remote host the user adds in the settings dialog. The local service owns the
// harness process; because `dsh web` mints its authentication token per process,
// that service publishes its URL in $XDG_RUNTIME_DIR/dsh-web/url (see the dsh-web
// user unit that serves it) and this app waits for it, so a window opened before
// the server is up attaches on its own.
//
// The window is frameless: its decoration is renderer/titlebar.html, a
// client-side bar this package owns, so controls that belong beside the harness
// have somewhere to live.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, WebContentsView, app, ipcMain, nativeTheme, shell } from "electron";
import { POLL_MS, dueForAttempt } from "./attach";
import { LOCAL, entries, label, normalize, read, target, write, type StoredHosts } from "./hosts";
import { channels, type HostList, type HostState } from "./ipc";
import {
  SshFailure,
  agentSummary,
  localize,
  publishedPort,
  remoteServiceUrl,
  startTunnel,
  type Tunnel,
} from "./tunnel";

// The harness UI is dark, and Chromium's own light/dark guess is unreliable on
// this desktop — it decides from GTK3, which does not report the configured
// theme — so pin the app's scheme rather than inherit the wrong answer. This is
// what colours the titlebar, the select popup, and the first paint; use
// "system" here to follow the desktop instead.
nativeTheme.themeSource = "dark";

/** Where the dsh-web unit parks its URL (RuntimeDirectory=dsh-web). */
const urlFile = path.join(
  process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
  "dsh-web",
  "url",
);

/** Height of our own titlebar; the harness page gets everything below it. */
const titlebarHeight = 36;

const pages = path.join(__dirname, "renderer");
const preloads = path.join(__dirname, "preload");
const startingPage = path.join(pages, "starting.html");
const titlebarPage = path.join(pages, "titlebar.html");
const settingsPage = path.join(pages, "settings.html");
const titlebarPreload = path.join(preloads, "titlebar.js");
const settingsPreload = path.join(preloads, "settings.js");

/** The harness mark, installed beside the pages; a source checkout has none. */
const icon = path.join(__dirname, "..", "icon.png");

/** The URL on display, or null while the page shows the waiting screen. */
let shown: string | null = null;
/** Whether the waiting page is loaded, so polling does not reload it. */
let waiting = false;
/** When the last load was attempted, for the remote retry cadence. */
let attemptedAt = 0;
/**
 * What the waiting page should explain: the plain wait, a forward coming up, the
 * far side wanting its launch token, why the last attempt failed, a forward that
 * is up with nothing behind it, or a host that refused this app's key.
 */
type Note = {
  kind: "waiting" | "tunnel" | "token" | "error" | "lost" | "auth";
  message?: string;
  /** For `auth`: which agent this window's ssh used, and what it held. */
  agent?: string;
};
let note: Note = { kind: "waiting" };

/** Record a new explanation; the waiting page reloads when it changes. */
function setNote(next: Note): void {
  if (next.kind === note.kind && next.message === note.message && next.agent === note.agent) return;
  note = next;
  // The waiting page is loaded once per state, so clear that to let it reload.
  waiting = false;
}

let window: BrowserWindow | null = null; // the frame itself
let titlebar: WebContentsView | null = null; // the client-side decoration
let content: WebContentsView | null = null; // the harness page
let settings: BrowserWindow | null = null; // the host dialog, while it is open

/** The persisted host list, and which entry is on screen. */
let stored: StoredHosts = { hosts: [], selected: LOCAL };

/** A forward that is up, with the address the harness view loads through it. */
interface Session {
  target: string;
  tunnel: Tunnel;
  url: string;
}

/** The forward currently up, one being brought up, and the last failure. */
let session: Session | null = null;
let pending: string | null = null;
/**
 * Why the last attempt for a target failed, what to say about it, and when to
 * try again. The note is kept, not just the message: a forward can be dropped
 * for a stale token, an unreachable host or a refused key, and the waiting
 * screen explains each differently.
 */
let failed: { target: string; until: number; note: Note } | null = null;

/** How long before a target whose forward failed is tried again. */
const TUNNEL_RETRY_MS = 15_000;

/**
 * A refused authentication is not retried on the ordinary cadence. The far side
 * penalises every failed authentication (OpenSSH's PerSourcePenalties: 5 s
 * each), so a reconnect attempt every 15 s would keep refreshing a block that
 * also stops the user's own ssh — and it cannot succeed until a human unlocks an
 * agent or fixes a key. One attempt a minute says so without becoming the
 * problem.
 */
const AUTH_RETRY_MS = 60_000;

const userData = (): string => app.getPath("userData");

/** This machine's service URL, or null when it is not serving. */
async function serviceUrl(): Promise<string | null> {
  try {
    const text = await fs.readFile(urlFile, "utf8");
    // A restart rewrites the file; the last line is the current token.
    return text.trim().split("\n").at(-1) || null;
  } catch {
    return null; // nothing published yet, or the service is down
  }
}

/**
 * Record why a target failed, and put the waiting screen on it. Every way a
 * forward can be lost goes through here, so the retry bookmark and the
 * explanation can never disagree.
 */
function failFor(name: string, cause: Note, retryMs = TUNNEL_RETRY_MS): void {
  failed = { target: name, until: Date.now() + retryMs, note: cause };
  setNote(cause);
  shown = null;
}

/**
 * The forward for an ssh target: bring it up when it is due, and answer the
 * address to load. Null while it is coming up — the waiting page says so.
 */
async function sshTargetUrl(name: string): Promise<string | null> {
  if (session !== null && session.target === name) return session.url;

  if (pending === name) {
    setNote({ kind: "tunnel" });
    return null;
  }
  if (failed !== null && failed.target === name) {
    if (Date.now() < failed.until) {
      setNote(failed.note);
      return null;
    }
    failed = null;
  }

  pending = name;
  setNote({ kind: "tunnel" });
  try {
    // What the far side says about itself decides both the token and the port
    // the forward points at — a deployment may serve on another one (saturn's
    // system unit uses 3080, the repo's own user unit 3090).
    const published = await remoteServiceUrl(name);
    const tunnel = await startTunnel(name, {
      remotePort: publishedPort(published) ?? undefined,
      onExit: (reason) => {
        // The forward died under us: forget it, say why, and let the loop retry.
        if (session !== null && session.target === name) session = null;
        failFor(name, { kind: "error", message: reason });
      },
    });
    if (stored.selected !== name) {
      // The user moved on while this was coming up.
      tunnel.stop();
      return null;
    }
    session = {
      target: name,
      tunnel,
      // Without a published URL the plain forward is all we have, and its 401
      // says as much.
      url: published === null ? tunnel.url : localize(published, tunnel.port),
    };
    failed = null;
    setNote({ kind: "waiting" });
    return session.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SshFailure && error.kind === "auth") {
      // A refused key is a human problem — a locked agent, or an agent that is
      // not the one holding the key — so say which agent this window used, and
      // stop retrying on the ordinary cadence: every attempt is another failed
      // authentication the far side penalises.
      failFor(
        name,
        { kind: "auth", message, agent: await agentSummary() },
        AUTH_RETRY_MS,
      );
    } else {
      failFor(name, { kind: "error", message });
    }
    return null;
  } finally {
    pending = null;
  }
}

/** Where the selected entry lives: this machine, a URL as given, or a forward. */
async function targetUrl(): Promise<string | null> {
  const where = target(stored.selected);
  switch (where.kind) {
    case "local":
      return await serviceUrl();
    case "url":
      return where.url;
    case "ssh":
      return await sshTargetUrl(where.target);
  }
}

/** Tear the current forward down: on a host switch, or on the way out. */
function stopSession(): void {
  session?.tunnel.stop();
  session = null;
  pending = null;
  failed = null;
}

/**
 * Drop a forward that is up but no longer reaches a harness: the page would not
 * load through it, or the far side refused the launch token it was carrying.
 *
 * `onExit` cannot see this. ssh only carries bytes, so it stays alive through
 * the far side restarting or forgetting its token — which is exactly when the
 * address on screen, token and all, has gone stale. Tearing the session down
 * sends the loop back through the bring-up, which re-reads what the far side
 * publishes now and spawns a fresh forward, instead of reloading a dead URL
 * until the user gives up and switches hosts.
 */
function invalidateSession(cause: Note): void {
  if (session === null) return;
  const { target: name, tunnel } = session;
  session = null;
  tunnel.stop(); // marks the exit deliberate, so onExit stays quiet
  failFor(name, cause);
}

/**
 * Whether a URL the harness view is on belongs to the forward that is up. Each
 * session forwards to a loopback port of its own, so the port identifies it.
 *
 * This is what keeps a navigation left over from the host the user just switched
 * away from — it failed, or was refused, after the switch — from tearing down the
 * forward that replaced it.
 */
function throughSession(url: string): boolean {
  if (session === null) return false;
  try {
    return new URL(url).port === String(session.tunnel.port);
  } catch {
    return false; // not a URL the harness view could have been on
  }
}

function hostState(): HostState {
  return { entries: entries(stored), selected: stored.selected };
}

async function showWaiting(): Promise<void> {
  if (waiting || content === null || content.webContents.isDestroyed()) return;
  waiting = true;
  await content.webContents
    .loadFile(startingPage, {
      query: {
        host: label(stored.selected),
        state: note.kind,
        error:
          note.kind === "error" || note.kind === "lost" || note.kind === "auth"
            ? (note.message ?? "")
            : "",
        agent: note.agent ?? "",
      },
    })
    .catch(() => {});
}

/**
 * Hold the harness page against whatever the selected entry is serving: wait
 * until the local service publishes a URL, load a target the first time it is
 * due, and drop back to the waiting page when a load fails (a restart, a port
 * not yet bound) so a later tick re-attaches.
 */
async function attach(): Promise<void> {
  for (;;) {
    if (content === null || content.webContents.isDestroyed()) return;
    const url = await targetUrl();
    const local = stored.selected === LOCAL;
    if (url === null) {
      shown = null;
      await showWaiting();
    } else if (dueForAttempt({ url, shown, local, attemptedAt, now: Date.now() })) {
      waiting = false;
      attemptedAt = Date.now();
      // A load can tear down its own session: a 401, a forward that died
      // mid-navigation. Recording the URL afterwards would claim the page shows
      // something nothing is listening for, and stop the loop from retrying it.
      const attempt = session;
      try {
        await content.webContents.loadURL(url);
        shown = session === attempt ? url : null;
      } catch {
        shown = null;
        await showWaiting();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Keep the titlebar pinned to the top and the page under it. */
function layout(): void {
  if (window === null || window.isDestroyed() || titlebar === null || content === null) return;
  const { width, height } = window.getContentBounds();
  titlebar.setBounds({ x: 0, y: 0, width, height: titlebarHeight });
  content.setBounds({
    x: 0,
    y: titlebarHeight,
    width,
    height: Math.max(0, height - titlebarHeight),
  });
}

function pushHosts(): void {
  if (titlebar === null || titlebar.webContents.isDestroyed()) return;
  titlebar.webContents.send(channels.hosts, hostState());
}

/** Move to another entry: clear what is on screen so the loop reloads it now. */
async function selectHost(value: string): Promise<void> {
  if (value !== LOCAL && !stored.hosts.includes(value)) return;
  stored.selected = value;
  stopSession();
  setNote({ kind: "waiting" });
  shown = null;
  waiting = false;
  attemptedAt = 0;
  await write(userData(), stored);
  pushHosts();
}

/** The dialog that edits the host list. */
function openSettings(): void {
  if (settings !== null && !settings.isDestroyed()) {
    settings.focus();
    return;
  }
  settings = new BrowserWindow({
    width: 460,
    height: 400,
    parent: window ?? undefined,
    modal: true,
    title: "Hosts",
    icon: existsSync(icon) ? icon : undefined,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: settingsPreload,
      // As for the titlebar: our own page, its preload needs its own module.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void settings.loadFile(settingsPage);
  settings.on("closed", () => {
    settings = null;
  });
}

function hostList(): HostList {
  return { entries: entries(stored), local: LOCAL };
}

// The titlebar is a local page with no other privileges, so these handlers are
// its entire reach into the app.
ipcMain.on(channels.minimize, () => window?.minimize());
ipcMain.on(channels.toggleMaximize, () => {
  if (window === null) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.on(channels.close, () => window?.close());
ipcMain.on(channels.openSettings, () => openSettings());
ipcMain.handle(channels.hosts, () => hostState());
ipcMain.handle(channels.selectHost, async (_event, value: unknown) => {
  await selectHost(String(value));
  return hostState();
});

// ...and the settings dialog's, which only ever edits the host list.
ipcMain.handle(channels.settingsList, () => hostList());
ipcMain.handle(channels.settingsAdd, async (_event, raw: unknown) => {
  const value = normalize(String(raw ?? ""));
  if (value === null) return { ...hostList(), error: "Enter a hostname first." };
  if (stored.hosts.includes(value)) {
    return { ...hostList(), error: `${label(value)} is already in the list.` };
  }
  stored.hosts.push(value);
  await write(userData(), stored);
  pushHosts();
  return hostList();
});
ipcMain.handle(channels.settingsRemove, async (_event, raw: unknown) => {
  const value = String(raw);
  stored.hosts = stored.hosts.filter((entry) => entry !== value);
  if (stored.selected === value) {
    // The entry on screen just went away; fall back to this machine.
    stored.selected = LOCAL;
    stopSession();
    setNote({ kind: "waiting" });
    shown = null;
    waiting = false;
    attemptedAt = 0;
  }
  await write(userData(), stored);
  pushHosts();
  return hostList();
});
ipcMain.on(channels.settingsClose, () => settings?.close());

// A second launch is a request to surface the window that already exists.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Point launchers at the desktop entry this package installs, whose Icon is
  // the harness mark, so the window never falls back to a generic icon.
  app.setDesktopName("dsh-chrome.desktop");

  app.on("second-instance", () => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(async () => {
    stored = await read(userData());

    window = new BrowserWindow({
      width: 1280,
      height: 860,
      frame: false,
      title: "DeepSeek Harness",
      // The mark, shipped beside this file, as the window-level icon. Wayland
      // launchers take it from the desktop entry instead (see setDesktopName
      // above), which is the route that matters on this desktop.
      icon: existsSync(icon) ? icon : undefined,
      // dsh's own light and dark base colours; the scheme is pinned dark above,
      // so this is the first paint behind the titlebar and the page.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#151517" : "#ffffff",
    });

    // The window's own webContents stays unused: the two views cover it, and
    // keeping the harness page in its own view is what leaves the bar free to
    // hold whatever this package wants to put there.
    titlebar = new WebContentsView({
      webPreferences: {
        preload: titlebarPreload,
        // contextIsolation still keeps the page away from the preload's world;
        // the sandbox is off only because a sandboxed preload cannot require
        // the module beside it (src/ipc.ts), and this page is one of our own.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    content = new WebContentsView({
      webPreferences: {
        // The page is dsh's own GUI: no preload, no node, no shared context.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.contentView.addChildView(titlebar);
    window.contentView.addChildView(content);

    void titlebar.webContents.loadFile(titlebarPage);
    layout();
    window.on("resize", layout);

    // dsh titles the page after the session; the bar shows the same string.
    content.webContents.on("page-title-updated", (_event, title) => {
      titlebar?.webContents.send(channels.title, title);
    });

    // A remote host answers 401 until it has seen this app's launch token once.
    // Say so instead of leaving Chromium's bare 401 body on screen — and for a
    // forward, take it as the token having gone stale: `dsh web` mints one per
    // process, so the far side restarting is enough to retire the one that came
    // in the URL. Re-reading what it publishes now is the way back in.
    content.webContents.on("did-navigate", (_event, loadedUrl, statusCode) => {
      // This machine's own service is reached through its runtime URL, token and
      // all, so a 401 here is not the far side asking for one.
      if (statusCode !== 401 || target(stored.selected).kind === "local") return;
      if (session !== null) {
        // Only the forward whose page this is; a 401 from the host we just left
        // says nothing about the one we are on.
        if (throughSession(loadedUrl)) invalidateSession({ kind: "token" });
        return;
      }
      setNote({ kind: "token" });
      void showWaiting();
    });

    // Links out of the GUI belong in the user's browser, not in this window.
    content.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });

    // A failed main-frame load means the target went away.
    //
    // A local service publishes a fresh URL when it restarts, and a URL entry is
    // taken as given, so for both the loop only has to try again. A forward is
    // different: ssh keeps carrying bytes whether or not anything is listening
    // behind it, so the tunnel outlives the harness it points at and the address
    // on screen goes stale rather than merely unreachable. Rebuild it — the
    // bring-up re-reads the far side and spawns a forward pointed at what it
    // says now.
    content.webContents.on(
      "did-fail-load",
      (_event, code, description, failedUrl, isMainFrame) => {
        // ERR_ABORTED (-3) is an ordinary redirect or superseded navigation, and
        // the waiting page is local, so neither counts.
        if (!isMainFrame || code === -3 || failedUrl.startsWith("file://")) return;
        if (session !== null) {
          // Only a forward has a session to lose, and only its own page is
          // evidence about it — not a failure from the host we just left.
          if (!throughSession(failedUrl)) return;
          const why = description === "" ? "" : ` (${description})`;
          invalidateSession({
            kind: "lost",
            message: `The forward is up, but nothing answered behind it${why}.`,
          });
          return;
        }
        shown = null;
      },
    );

    window.on("closed", () => {
      window = null;
      titlebar = null;
      content = null;
    });

    void attach();
  });

  app.on("window-all-closed", () => app.quit());
  // Never leave a forward running behind us.
  app.on("will-quit", () => stopSession());
}
