import { defineConfig } from "vite";
import { cpSync, readdirSync } from "node:fs";
import path from "node:path";

// `base: "./"` makes built asset URLs relative, so the bundle loads from the `tauri://`
// origin in the desktop shell (absolute `/assets` 404s there). Dev runs on a fixed port (1420) with strictPort so the Tauri webview always
// loads the vite instance Tauri itself spawns (a drifting port would make the window load a
// stale/other server). `tauri.conf.json` devUrl must match this.
export default defineConfig(() => {
  const devToken = "";
  return {
    base: "./",
    build: { copyPublicDir: false },
    plugins: [{
      name: "desktop-public-assets",
      writeBundle(output) {
        // The agent's live library stays on disk, outside the application bundle.
        for (const entry of readdirSync("public")) {
          if (entry !== "youtube") cpSync(path.join("public", entry), path.join(output.dir!, entry), { recursive: true });
        }
      },
    }],
    server: { port: 1420, strictPort: true },
    define: { __COWORKER_DEV_TOKEN__: JSON.stringify(devToken) },
    // Tauri CLI looks for these; harmless for the browser build.
    clearScreen: false,
    envPrefix: ["VITE_", "TAURI_"],
  };
});
