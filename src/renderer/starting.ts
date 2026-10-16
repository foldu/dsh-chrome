// main.ts fills the waiting page in with the selected host and why it is not on
// screen yet: a forward coming up, a far side that wants its launch token, or
// what went wrong. A classic script (see globals.d.ts), so it keeps its names
// inside an IIFE.
(() => {
  const params = new URLSearchParams(location.search);
  const host = params.get("host") ?? "local";
  const state = params.get("state") ?? "waiting";
  const error = params.get("error") ?? "";
  const local = host === "local";
  const heading = document.getElementById("heading") as HTMLHeadingElement;
  const detail = document.getElementById("detail") as HTMLParagraphElement;
  const hint = document.getElementById("hint") as HTMLParagraphElement;

  function show(nextHeading: string, nextDetail: string, nextHint?: string): void {
    // The titlebar shows this page's title, so it says what is happening too —
    // without the heading's trailing ellipsis.
    document.title = nextHeading.replace(/…$/, "");
    heading.textContent = nextHeading;
    detail.textContent = nextDetail;
    if (nextHint === undefined) {
      hint.hidden = true;
    } else {
      hint.textContent = nextHint;
      hint.hidden = false;
    }
  }

  if (state === "tunnel") {
    show(`Tunnelling to ${host}…`, "The window connects as soon as the forward is up.");
    return;
  }

  if (state === "token") {
    show(
      `Waiting for ${host}…`,
      `${host} needs this app's launch token once.`,
      "Edit the host and paste the URL that host prints at startup, including its ?token=…",
    );
    return;
  }

  if (state === "lost") {
    // The forward is still up; it is the far side that stopped answering. Saying
    // "cannot reach <host>" here would send the user to check their ssh key,
    // which the forward coming up at all has already proved.
    show(
      `Reconnecting to ${host}…`,
      error === "" ? "The forward was up, but nothing answered behind it." : error,
      "The window builds a fresh forward on its own.",
    );
    return;
  }

  if (state === "error") {
    show(
      `Cannot reach ${host}`,
      error === "" ? "The last attempt failed." : error,
      "Check that the host is reachable and that your ssh key is available to this app.",
    );
    return;
  }

  if (local) {
    // The shipped copy already says this, systemctl hint and all.
    return;
  }

  show(`Waiting for ${host}…`, "This window connects on its own once that host answers.");
})();
