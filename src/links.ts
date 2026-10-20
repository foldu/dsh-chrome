// Which URLs the harness view performs itself, and which are a request for an
// application on this machine.
//
// The harness is a web page: its pages and assets are http(s), and it may render
// a blob: or data: URL. Everything else — `zed://ssh/<host>/<path>` in the
// agent's output, `mailto:`, `dsh-app://…` — is not something a web view can
// serve; it is a link meant for the desktop's own handler. Handing those to
// `shell.openExternal` is what lets a remote project open in the Zed running on
// this machine rather than the one on the host serving the page.

/** Schemes a web page may navigate to without leaving the harness view. */
const VIEW_SCHEMES = new Set(["http:", "https:", "file:", "blob:", "data:", "about:"]);

/**
 * Whether the harness view should perform this navigation itself. An unparseable
 * URL is left to Chromium — it is not a link anyone meant to hand to an app.
 */
export function navigatesInView(url: string): boolean {
  try {
    return VIEW_SCHEMES.has(new URL(url).protocol);
  } catch {
    return true;
  }
}
