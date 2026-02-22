const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proton', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  isProton: true,
});
