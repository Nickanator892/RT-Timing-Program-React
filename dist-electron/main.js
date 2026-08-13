import { ipcMain as d, BrowserWindow as P, screen as _, app as c } from "electron";
import r from "path";
import { fileURLToPath as j } from "url";
import h from "fs";
import { spawn as x, execSync as I } from "child_process";
import k from "http";
const V = j(import.meta.url), R = r.dirname(V), w = process.env.VITE_DEV_SERVER_URL !== void 0, D = w ? r.join(process.cwd(), "electron", "preload.js") : r.join(R, "preload.js");
let g = [], i = null, s = null, l = null, p = null, E = null, y = 0, n = {
  displayTimer: "00:00:00",
  activeButton: null,
  elapsedTime: 0,
  isRunning: !1,
  selectedUser: null,
  pauseReason: [],
  currentSessionStart: null,
  sessions: []
};
function $() {
  const t = w ? r.join(process.cwd(), "src/backend/server.ts") : r.join(process.resourcesPath, "dist-server/server.js"), e = w ? r.join(process.cwd(), "src/backend/db.worker.cjs") : r.join(process.resourcesPath, "dist-server/db.worker.cjs"), o = w ? r.join(process.cwd(), "db-config.json") : r.join(c.getPath("userData"), "db-config.json"), a = w ? r.join(process.cwd(), "node_modules/better-sqlite3") : r.join(process.resourcesPath, "app.asar.unpacked/node_modules/better-sqlite3"), u = w ? "npx" : "node", v = w ? ["tsx", t] : [t], m = r.join(c.getPath("userData"), "server.log");
  h.writeFileSync(
    m,
    `serverPath: ${t}
workerPath: ${e}
configPath: ${o}
serverPath exists: ${h.existsSync(t)}
workerPath exists: ${h.existsSync(e)}
`
  ), l = x(u, v, {
    shell: !1,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: !0,
    detached: !1,
    env: {
      ...process.env,
      WORKER_PATH: e,
      DB_CONFIG_PATH: o,
      BETTER_SQLITE3_PATH: a
    }
  }), l.stderr.on("data", (f) => h.appendFileSync(m, `Server error: ${f.toString()}
`)), l.stdout.on("data", (f) => h.appendFileSync(m, `Server: ${f.toString()}
`)), l.on("error", (f) => h.appendFileSync(m, `Failed to start server: ${f}
`)), l.on("exit", (f) => h.appendFileSync(m, `Server exited with code ${f}
`));
}
function L() {
  try {
    I("fuser -k 5000/tcp", { stdio: "ignore" });
  } catch {
  }
}
function b() {
  l && (l.kill("SIGTERM"), setTimeout(() => {
    l && (l.kill("SIGKILL"), l = null);
  }, 2e3), l = null);
}
function S(t) {
  g.forEach((e) => {
    e.isDestroyed() || e.webContents.send("shared-data-changed", t);
  });
}
let T = null;
function F(t) {
  T && clearTimeout(T), T = setTimeout(() => {
    S(t);
  }, 100);
}
function U(t) {
  const e = Math.floor(t / 1e3), o = Math.floor(e / 3600), a = Math.floor(e % 3600 / 60), u = e % 60;
  return `${String(o).padStart(2, "0")}:${String(a).padStart(2, "0")}:${String(
    u
  ).padStart(2, "0")}`;
}
d.on("timer-start", () => {
  if (p) return;
  E = Date.now() - y, n.isRunning = !0, S(n);
  function t() {
    y = Date.now() - E;
    const e = U(y);
    n.displayTimer = e, n.elapsedTime = y, S(n);
    const o = y % 1e3;
    p = setTimeout(t, 1e3 - o);
  }
  p = setTimeout(t, 1e3);
});
d.on("timer-pause", () => {
  p && (clearTimeout(p), p = null), n.isRunning = !1, S(n);
});
d.on("timer-reset", () => {
  p && (clearTimeout(p), p = null), y = 0, E = null, n.displayTimer = "00:00:00", n.elapsedTime = 0, n.isRunning = !1, S(n);
});
d.handle("get-shared-data", () => n);
d.handle("get-window-type", (t) => {
  const e = P.fromWebContents(t.sender);
  return e === i ? "main" : e === s ? "analytics" : "unknown";
});
d.on("update-shared-data", (t, e) => {
  n = { ...n, ...e }, F(n);
});
d.on("add-session", (t, e) => {
  n.sessions.push(e), S(n);
});
d.on("open-analytics-window", () => {
  A();
});
function q() {
  const e = _.getAllDisplays()[0], { x: o, y: a } = e.bounds;
  return i = new P({
    width: 1280,
    height: 720,
    x: o,
    y: a,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: D,
      contextIsolation: !0,
      nodeIntegration: !1
    },
    resizable: !1,
    maximizable: !1
  }), i.once("ready-to-show", () => {
    i.setPosition(o, a), i.maximize(), i.show();
  }), g.push(i), i.on("closed", () => {
    g = g.filter((u) => u !== i), i = null;
  }), process.env.VITE_DEV_SERVER_URL ? (i.loadURL(process.env.VITE_DEV_SERVER_URL), i.webContents.openDevTools()) : i.loadFile(r.join(R, "../dist/index.html")), i;
}
function A() {
  const e = _.getAllDisplays()[0], { x: o, y: a } = e.bounds;
  return s && !s.isDestroyed() || (s = new P({
    width: 1920,
    height: 1080,
    x: o,
    y: a,
    fullscreen: !1,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: D,
      contextIsolation: !0,
      nodeIntegration: !1
    },
    title: "Analytics Dashboard"
  }), s.once("ready-to-show", () => {
    s.setPosition(o, a), s.maximize(), s.show();
  }), g.push(s), s.on("closed", () => {
    g = g.filter((u) => u !== s), s = null;
  }), process.env.VITE_DEV_SERVER_URL ? s.loadURL(process.env.VITE_DEV_SERVER_URL + "#/analytics") : s.loadFile(r.join(R, "../dist/index.html"), {
    hash: "analytics"
  })), s;
}
d.on("quit-app", () => {
  c.quit();
});
function M(t, e = 30, o = 500) {
  return new Promise((a, u) => {
    let v = 0;
    function m() {
      k.get(t, (f) => {
        a();
      }).on("error", () => {
        v++, v >= e ? u(new Error("Server did not start in time")) : setTimeout(m, o);
      });
    }
    m();
  });
}
d.handle("run-updater", () => {
  if (process.platform !== "linux") {
    console.log("Updater only runs on Linux, skipping...");
    return;
  }
  x("lxterminal", ["-e", "npx tsx /usr/local/rt-timing-updater/updater/update.ts"], {
    detached: !0,
    stdio: "ignore",
    shell: !0,
    cwd: "/usr/local/rt-timing-updater/updater",
    env: {
      ...process.env,
      DISPLAY: ":0"
    }
  }).unref(), setTimeout(() => {
    c.quit();
  }, 500);
});
c.whenReady().then(async () => {
  L(), $();
  try {
    await M("http://localhost:5000/api/db-status");
  } catch (t) {
    const e = r.join(c.getPath("userData"), "server.log");
    h.appendFileSync(e, `Server never became ready: ${t}
`);
  }
  q();
});
c.on("before-quit", () => {
  b();
});
c.on("window-all-closed", () => {
  b(), process.platform !== "darwin" && c.quit();
});
c.on("will-quit", () => {
  b();
});
