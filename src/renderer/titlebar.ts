// The titlebar's behaviour: the host combobox, the settings button, the window
// controls, and the harness page's own title. A classic script — see
// globals.d.ts — so it is wrapped in an IIFE to keep its names out of the shared
// page scope, and it uses the API the preload exposes rather than importing.
(() => {
  const api = window.dshTitlebar;
  const title = document.getElementById("title") as HTMLSpanElement;
  const host = document.getElementById("host") as HTMLSelectElement;
  const settingsButton = document.getElementById("settings") as HTMLButtonElement;
  const mark = document.getElementById("mark") as HTMLImageElement;

  let rendered = "";

  function renderHosts(state: DshHostState): void {
    // Rebuild only when the list itself changed: replacing the options drops
    // the select's focus, which would eat the next arrow key.
    const key = state.entries.map((entry) => entry.value).join("\n");
    if (key !== rendered) {
      rendered = key;
      host.replaceChildren(
        ...state.entries.map((entry) => {
          const option = document.createElement("option");
          option.value = entry.value;
          option.textContent = entry.label;
          return option;
        }),
      );
    }
    host.value = state.selected;
  }

  // The page titles itself after the session ("<session> — DeepSeek Harness"),
  // which is what the bar shows until the service answers.
  api.onTitle((value) => {
    if (value) title.textContent = value;
  });

  // Pulled once on load, pushed again whenever the dialog changes the list.
  void api.hosts().then(renderHosts);
  api.onHosts(renderHosts);

  host.addEventListener("change", () => {
    void api.selectHost(host.value);
  });
  settingsButton.addEventListener("click", () => api.openSettings());

  // The mark starts hidden and only shows once it has actually loaded: a missing
  // icon should leave no gap and no broken-image glyph. The check on `complete`
  // covers a load that finished — or failed — before this ran.
  mark.addEventListener("load", () => {
    mark.hidden = false;
  });
  mark.addEventListener("error", () => {
    mark.hidden = true;
  });
  if (mark.complete && mark.naturalWidth > 0) mark.hidden = false;

  const actions: Record<string, () => void> = {
    minimize: () => api.minimize(),
    maximize: () => api.toggleMaximize(),
    close: () => api.close(),
  };
  for (const [id, action] of Object.entries(actions)) {
    document.getElementById(id)?.addEventListener("click", action);
  }
})();
