// Ambient types for the page scripts. They are classic scripts — file:// pages
// cannot load ES modules — so they cannot import anything: the preloads put
// these objects on window, and the preload sources assert themselves against
// these interfaces so the two cannot drift apart.
interface DshHostEntry {
  value: string;
  label: string;
}

interface DshHostState {
  entries: DshHostEntry[];
  selected: string;
}

interface DshHostList {
  entries: DshHostEntry[];
  local: string;
}

interface DshHostResult extends DshHostList {
  error?: string;
}

interface DshTitlebarApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  hosts(): Promise<DshHostState>;
  selectHost(value: string): Promise<DshHostState>;
  openSettings(): void;
  onHosts(listener: (state: DshHostState) => void): void;
  onTitle(listener: (title: string) => void): void;
}

interface DshSettingsApi {
  list(): Promise<DshHostList>;
  add(value: string): Promise<DshHostResult>;
  remove(value: string): Promise<DshHostResult>;
  close(): void;
}

interface Window {
  dshTitlebar: DshTitlebarApi;
  dshSettings: DshSettingsApi;
}
