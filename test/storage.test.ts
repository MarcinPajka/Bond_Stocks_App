import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDataDir, migrateFromAppFolder, readPortfolioFile, writePortfolioFile } from "../src/storage.js";
import { withKnownSources } from "../src/portfolio.js";

const dir = () => mkdtempSync(join(tmpdir(), "portfel-"));

describe("data folder", () => {
  it("lives outside the app folder, per system", () => {
    expect(defaultDataDir({ APPDATA: "C:\\Users\\m\\AppData\\Roaming" }, "win32", "C:\\Users\\m")).toMatch(/AppData.Roaming.portfel$/);
    expect(defaultDataDir({}, "darwin", "/Users/m")).toBe("/Users/m/Library/Application Support/portfel");
    expect(defaultDataDir({}, "linux", "/home/m")).toBe("/home/m/.local/share/portfel");
    expect(defaultDataDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/m")).toBe("/data/portfel");
    expect(defaultDataDir({ PORTFEL_DATA: "/mine" }, "linux", "/home/m")).toBe("/mine");
  });

  it("copies data kept next to the code by older versions, once", () => {
    const app = dir(), data = join(dir(), "portfel");
    writeFileSync(join(app, "portfolio.json"), '{"bonds":[]}');
    writeFileSync(join(app, "market-data.cache.json"), "{}");
    expect(migrateFromAppFolder(app, data)).toEqual(["portfolio.json", "market-data.cache.json"]);
    expect(readFileSync(join(data, "portfolio.json"), "utf8")).toBe('{"bonds":[]}');
    expect(existsSync(join(app, "portfolio.json"))).toBe(true); // left in place

    writeFileSync(join(app, "portfolio.json"), '{"bonds":[{"series":"OLD"}]}');
    expect(migrateFromAppFolder(app, data)).toEqual([]); // the data folder already has a portfolio
    expect(readFileSync(join(data, "portfolio.json"), "utf8")).toBe('{"bonds":[]}');
  });
});

describe("saving", () => {
  it("stamps the format version and keeps the previous save as a backup", () => {
    const file = join(dir(), "portfolio.json");
    writePortfolioFile(file, { bonds: [] });
    writePortfolioFile(file, { trades: [] });
    expect(readPortfolioFile(file)).toEqual({ trades: [], version: 1 });
    expect(JSON.parse(readFileSync(file.replace(".json", ".backup.json"), "utf8"))).toEqual({ bonds: [], version: 1 });
  });

  it("won't overwrite a file from a newer, incompatible version", () => {
    const file = join(dir(), "portfolio.json");
    writeFileSync(file, '{"version":2,"bonds":[]}');
    expect(() => writePortfolioFile(file, {})).toThrow(/newer version/);
    expect(readFileSync(file, "utf8")).toBe('{"version":2,"bonds":[]}');
  });
});

describe("price sources", () => {
  it("fills in a known source for an instrument saved without one, and nothing else", () => {
    const known = [{ symbol: "PKODFE", currency: "PLN", analizy: "EBAN2", name: "PKO DFE" }];
    const p = withKnownSources({
      instruments: [
        { symbol: "pkodfe", currency: "PLN" },
        { symbol: "XYZ", currency: "PLN", analizy: "ABC12" },
      ],
    }, known);
    expect(p.instruments![0]).toMatchObject({ symbol: "pkodfe", analizy: "EBAN2", name: "PKO DFE" });
    expect(p.instruments![1]).toEqual({ symbol: "XYZ", currency: "PLN", analizy: "ABC12" });
  });

  it("knows PKO DFE from the app's own instrument list", () => {
    expect(withKnownSources({ instruments: [{ symbol: "PKODFE", currency: "PLN" }] }).instruments![0].analizy).toBe("EBAN2");
  });
});
