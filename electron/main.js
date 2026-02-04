import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// For development
const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;
const preloadPath = isDev 
    ? path.join(process.cwd(), 'electron', 'preload.js')
    : path.join(__dirname, 'preload.js');

console.log('Preload path:', preloadPath);
console.log('Does it exist?', fs.existsSync(preloadPath));

const settingsPath = path.join(__dirname, 'settings.json');

// IPC Handlers
ipcMain.handle('read-settings', async () => {
    try {
        const data = fs.readFileSync(settingsPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Failed to read settings:', error);
        return { pauseReasons: [] };
    }
});

ipcMain.handle('write-settings', async (event, settings) => {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return { success: true };
    } catch (error) {
        console.error('Failed to write settings:', error);
        return { success: false, error: error.message };
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
        },
        resizable: false,
        maximizable: false,
        center: true,
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL);
        win.webContents.openDevTools(); // Open dev tools to see console
    } else {
        win.loadFile(path.join(__dirname, "../dist/index.html"));
    }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});