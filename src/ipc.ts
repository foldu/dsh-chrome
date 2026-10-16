// The payloads and channel names the three processes agree on: main.ts owns the
// state, the preloads expose a slice of it, and the renderer pages render it.

/** One entry in the titlebar's combobox. */
export interface HostEntry {
  /** The stored value: "local", or a URL. */
  value: string;
  /** What to show for it: "local", or the URL's host. */
  label: string;
}

/** What the titlebar renders. */
export interface HostState {
  entries: HostEntry[];
  selected: string;
}

/** What the settings dialog renders: the same entries the combobox shows. */
export interface HostList {
  entries: HostEntry[];
  local: string;
}

/** The result of adding or removing a host. */
export interface HostResult extends HostList {
  error?: string;
}

/** The titlebar page's API, as exposed by preload/titlebar.ts. */
export interface TitlebarApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  hosts(): Promise<HostState>;
  selectHost(value: string): Promise<HostState>;
  openSettings(): void;
  onHosts(listener: (state: HostState) => void): void;
  onTitle(listener: (title: string) => void): void;
}

/** The settings page's API, as exposed by preload/settings.ts. */
export interface SettingsApi {
  list(): Promise<HostList>;
  add(value: string): Promise<HostResult>;
  remove(value: string): Promise<HostResult>;
  close(): void;
}

/** Channel names, so main and the preloads cannot drift apart. */
export const channels = {
  minimize: "titlebar:minimize",
  toggleMaximize: "titlebar:toggle-maximize",
  close: "titlebar:close",
  openSettings: "titlebar:open-settings",
  hosts: "titlebar:hosts",
  selectHost: "titlebar:select-host",
  title: "titlebar:title",
  settingsList: "settings:list",
  settingsAdd: "settings:add",
  settingsRemove: "settings:remove",
  settingsClose: "settings:close",
} as const;
