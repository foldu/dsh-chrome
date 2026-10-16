// The titlebar page's whole surface. contextIsolation and the sandbox are on, so
// the page can reach only these functions — add a control by adding one here and
// its handler in main.ts.
import { contextBridge, ipcRenderer } from "electron";
import { channels, type HostState, type TitlebarApi } from "../ipc";

const api: TitlebarApi = {
  minimize: () => ipcRenderer.send(channels.minimize),
  toggleMaximize: () => ipcRenderer.send(channels.toggleMaximize),
  close: () => ipcRenderer.send(channels.close),
  hosts: () => ipcRenderer.invoke(channels.hosts) as Promise<HostState>,
  selectHost: (value) => ipcRenderer.invoke(channels.selectHost, value) as Promise<HostState>,
  openSettings: () => ipcRenderer.send(channels.openSettings),
  onHosts: (listener) => {
    ipcRenderer.on(channels.hosts, (_event, state: HostState) => listener(state));
  },
  onTitle: (listener) => {
    ipcRenderer.on(channels.title, (_event, title: string) => listener(title));
  },
};

// The page sees this through the ambient types in renderer/globals.d.ts; this
// assignment is what keeps that declaration and the real API in step.
const checked: DshTitlebarApi = api;

contextBridge.exposeInMainWorld("dshTitlebar", checked);
