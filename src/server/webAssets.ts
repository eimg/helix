/**
 * Web UI delivery for the Helix server.
 *
 * Built mode serves the Vite output from dist. Source mode (HELIX_DEV=1, set by
 * `npm run dev` and by the `helix-dev` bin) mounts Vite as middleware instead, so
 * editing web/ takes effect over HMR and `helix serve` never needs a prior build.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type RequestHandler } from "express";
import type { ViteDevServer } from "vite";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceWebDir = resolve(packageRoot, "web");
const sourceIndex = join(sourceWebDir, "index.html");
const builtWebDir = resolve(packageRoot, "dist/web");
const builtIndex = join(builtWebDir, "index.html");

export function webFromSource(): boolean {
  return process.env.HELIX_DEV === "1" && existsSync(sourceIndex);
}

let hmrHost: Server | undefined;
let devServer: Promise<ViteDevServer> | undefined;

/**
 * Call right after listen(). Vite is created on the first request, so by then this
 * carries HMR over the app's own port rather than Vite's fixed default, which would
 * clash whenever two of these servers run at once.
 */
export function attachHmr(server: Server): void {
  hmrHost = server;
}

function viteDevServer(): Promise<ViteDevServer> {
  // Built inline rather than from vite.config.ts: that config proxies API paths to
  // a standalone Helix, which would make an embedded Vite proxy back to its own host.
  devServer ??= Promise.all([import("vite"), import("@vitejs/plugin-react")]).then(
    ([vite, react]) =>
      vite.createServer({
        configFile: false,
        root: sourceWebDir,
        appType: "custom",
        plugins: [react.default()],
        server: { middlewareMode: true, hmr: hmrHost ? { server: hmrHost } : true },
      }),
  );
  return devServer;
}

/** Mount before the API routes: in source mode this serves modules, HMR and public/. */
export function webAssets(): RequestHandler {
  if (!webFromSource()) return express.static(builtWebDir, { index: false });
  const pending = viteDevServer();
  pending.catch((err: unknown) => {
    console.error("Vite dev server failed to start:", err instanceof Error ? err.message : err);
  });
  return (req, res, next) => {
    pending.then((vite) => vite.middlewares(req, res, next)).catch(next);
  };
}

/** Mount after the API routes, on the paths that should return the SPA shell. */
export function webIndex(): RequestHandler {
  if (!webFromSource()) return (_req, res) => res.sendFile(builtIndex);
  return (req, res, next) => {
    viteDevServer()
      .then(async (vite) => {
        const html = await readFile(sourceIndex, "utf8");
        res.status(200).type("html").end(await vite.transformIndexHtml(req.originalUrl, html));
      })
      .catch(next);
  };
}
