// The settings dialog: the host list, the input, and the add button. A classic
// script (see globals.d.ts), so it keeps its names inside an IIFE.
(() => {
  const api = window.dshSettings;
  const list = document.getElementById("list") as HTMLUListElement;
  const error = document.getElementById("error") as HTMLParagraphElement;
  const value = document.getElementById("value") as HTMLInputElement;
  const form = document.getElementById("add") as HTMLFormElement;
  const done = document.getElementById("done") as HTMLButtonElement;

  function row(entry: DshHostEntry, local: string): HTMLLIElement {
    const item = document.createElement("li");
    const name = document.createElement("span");
    // The label, as in the combobox: it is the host without any launch token.
    name.textContent = entry.value === local ? "local — this machine" : entry.label;
    item.append(name);
    if (entry.value !== local) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = "Remove";
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        void api.remove(entry.value).then(render);
      });
      item.append(remove);
    }
    return item;
  }

  async function render(): Promise<void> {
    const { entries, local } = await api.list();
    list.replaceChildren(...entries.map((entry) => row(entry, local)));
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await api.add(value.value);
    error.hidden = true;
    if (result.error !== undefined) {
      error.textContent = result.error;
      error.hidden = false;
      return;
    }
    value.value = "";
    await render();
  }

  form.addEventListener("submit", (event) => {
    void submit(event);
  });
  done.addEventListener("click", () => api.close());

  void render();
  value.focus();
})();
