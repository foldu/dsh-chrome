// The settings dialog's whole surface.
import { contextBridge, ipcRenderer } from "electron";
import { channels, type HostList, type HostResult, type SettingsApi } from "../ipc";

const api: SettingsApi = {
  list: () => ipcRenderer.invoke(channels.settingsList) as Promise<HostList>,
  add: (value) => ipcRenderer.invoke(channels.settingsAdd, value) as Promise<HostResult>,
  remove: (value) => ipcRenderer.invoke(channels.settingsRemove, value) as Promise<HostResult>,
  close: () => ipcRenderer.send(channels.settingsClose),
};

// The page sees this through the ambient types in renderer/globals.d.ts; this
// assignment is what keeps that declaration and the real API in step.
const checked: DshSettingsApi = api;

contextBridge.exposeInMainWorld("dshSettings", checked);
