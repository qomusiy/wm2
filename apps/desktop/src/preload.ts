import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { HostStatus, LinkMode } from '@watchroom/protocol';

// The only bridge between the page and the host's computer. Every call is re-validated in the main process.
contextBridge.exposeInMainWorld('watchroomHost', {
  getStatus: () => ipcRenderer.invoke('host:getStatus'),
  hostJoin: () => ipcRenderer.invoke('host:hostJoin'),
  openVideoDialog: () => ipcRenderer.invoke('host:openVideoDialog'),
  openVideoFile: (file: File) => ipcRenderer.invoke('host:openVideoPath', webUtils.getPathForFile(file)),
  closeVideo: () => ipcRenderer.invoke('host:closeVideo'),
  listRecent: () => ipcRenderer.invoke('host:listRecent'),
  openRecent: (id: string, fromStart: boolean) => ipcRenderer.invoke('host:openRecent', id, fromStart),
  removeRecent: (id: string | null) => ipcRenderer.invoke('host:removeRecent', id),
  setLinkMode: (mode: LinkMode, customBase?: string | null) => ipcRenderer.invoke('host:setLinkMode', mode, customBase ?? null),
  retryTunnel: () => ipcRenderer.invoke('host:retryTunnel'),
  regenerateLink: () => ipcRenderer.invoke('host:regenerateLink'),
  addSubtitleDialog: () => ipcRenderer.invoke('host:addSubtitleDialog'),
  copyText: (text: string) => ipcRenderer.invoke('host:copyText', text),
  openExternal: (url: string) => ipcRenderer.invoke('host:openExternal', url),
  onStatus: (cb: (s: HostStatus) => void) => {
    const handler = (_e: unknown, s: HostStatus) => cb(s);
    ipcRenderer.on('host:status', handler);
    return () => ipcRenderer.removeListener('host:status', handler);
  },
  platform: process.platform,
});
