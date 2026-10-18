import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PortfolioFile } from "./portfolio.js";

/**
 * Where your data lives. It is kept outside the app folder, so downloading or pulling a
 * new version of the app never touches it:
 *   Windows  %APPDATA%\portfel
 *   macOS    ~/Library/Application Support/portfel
 *   Linux    $XDG_DATA_HOME/portfel, else ~/.local/share/portfel
 * PORTFEL_DATA=/some/folder overrides it.
 */
export function defaultDataDir(env = process.env, platform: string = process.platform, home = homedir()): string {
  if (env.PORTFEL_DATA) return env.PORTFEL_DATA;
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "portfel");
  if (platform === "darwin") return join(home, "Library", "Application Support", "portfel");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "portfel");
}

/** Version of the portfolio file format this app reads and writes. */
export const FORMAT_VERSION = 1;

const DATA_FILES = ["portfolio.json", "market-data.cache.json", "price-history.cache.json"];

/**
 * Older versions kept the data next to the code. Copies it into the data folder once,
 * when the data folder has no portfolio yet; the old files are left where they were.
 */
export function migrateFromAppFolder(appDir: string, dataDir: string): string[] {
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(join(dataDir, "portfolio.json")) || !existsSync(join(appDir, "portfolio.json"))) return [];
  const copied = DATA_FILES.filter((f) => existsSync(join(appDir, f)));
  for (const f of copied) copyFileSync(join(appDir, f), join(dataDir, f));
  return copied;
}

/** Throws for a file written by a newer app whose format this one doesn't know. */
export function checkCompatible(p: PortfolioFile): void {
  if ((p.version ?? 1) > FORMAT_VERSION) {
    throw new Error(
      `Your portfolio was saved by a newer version of the app (file format ${p.version}, this app reads ${FORMAT_VERSION}). ` +
        `Update the app; the file has not been changed.`,
    );
  }
}

export function readPortfolioFile(path: string): PortfolioFile {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/**
 * Saves the portfolio without ever leaving a half-written file: the previous save is kept
 * as portfolio.backup.json and the new one is written to a temporary file, then renamed.
 */
export function writePortfolioFile(path: string, next: PortfolioFile): void {
  if (existsSync(path)) {
    checkCompatible(readPortfolioFile(path));
    copyFileSync(path, path.replace(/\.json$/, "") + ".backup.json");
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...next, version: FORMAT_VERSION }, null, 2));
  renameSync(tmp, path);
}
