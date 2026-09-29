import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import {
  HERMES_ENV_KEY,
  HERMES_ENV_MARKER,
  HERMES_PROVIDER_FILES,
  getHermesEnvPath,
  getHermesIntegrationJournalPath,
  getHermesProviderDir,
  inspectHermesIntegrationStatus,
  installHermesIntegration,
  preflightHermesIntegration,
  uninstallHermesIntegration,
} from "../src/hermes-integration";

const roots: string[] = [];

function fixture(initialEnv?: string) {
  const root = join(tmpdir(), `codex-chatgpt-web-hermes-${process.pid}-${Date.now()}-${Math.random()}`);
  const home = join(root, "hermes-home");
  process.env.HERMES_HOME = home;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  roots.push(root);
  if (initialEnv !== undefined) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".env"), initialEnv);
  }
  return { root, home };
}

/** Every path the integration owns, with its exact bytes. */
function ownedFiles(): Array<[string, string | null]> {
  const paths = [
    getHermesEnvPath(),
    ...HERMES_PROVIDER_FILES.map(name => join(getHermesProviderDir(), name)),
    getHermesIntegrationJournalPath(),
  ];
  return paths.map(path => [path, existsSync(path) ? readFileSync(path, "utf8") : null]);
}

function providerFile(name: string): string {
  return readFileSync(join(getHermesProviderDir(), name), "utf8");
}

function journal(): Record<string, any> {
  return JSON.parse(readFileSync(getHermesIntegrationJournalPath(), "utf8"));
}

afterEach(() => {
  delete process.env.HERMES_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reversible Hermes integration", () => {
  test("installs the marker key and both provider files, then reports installed", () => {
    fixture();

    installHermesIntegration(defaultConfig("browser-only"));

    expect(readFileSync(getHermesEnvPath(), "utf8")).toBe(`${HERMES_ENV_KEY}=${HERMES_ENV_MARKER}\n`);
    const init = providerFile("__init__.py");
    expect(init.startsWith('"""ChatGPT Web — les modeles du bridge local codex-chatgpt-web.\n')).toBe(true);
    expect(init.endsWith("register_provider(gpt_web)\n")).toBe(true);
    expect(init).toContain('api_mode="anthropic_messages"');
    expect(init).toContain('base_url="http://127.0.0.1:17841"');
    expect(init).toContain('env_vars=("GPT_WEB_API_KEY",)');
    for (const model of ["gpt-6-pro", "gpt-5.6-pro", "gpt-5.6-sol", "gpt-5.6-sol-instant", "pro", "high", "extra-high", "medium", "light"]) {
      expect(init).toContain(`"chatgpt-web/${model}"`);
    }
    expect(providerFile("plugin.yaml")).toBe(
      "name: gpt-web-provider\nkind: model-provider\nversion: 1.0.0\n"
      + "description: Modeles Web ChatGPT via le bridge local codex-chatgpt-web\nauthor: Florian\n",
    );
    expect(existsSync(getHermesIntegrationJournalPath())).toBe(true);
    expect(inspectHermesIntegrationStatus()).toBe("installed");
  });

  test("points the provider at the configured host and port", () => {
    fixture();

    installHermesIntegration({ ...defaultConfig("browser-only"), port: 12345 });

    expect(providerFile("__init__.py")).toContain('base_url="http://127.0.0.1:12345"');
    expect(inspectHermesIntegrationStatus()).toBe("installed");
  });

  test("preserves unrelated .env lines, order, comments and BOM without touching ANTHROPIC_*", () => {
    const initial = "\uFEFF# Hermes environment\nANTHROPIC_BASE_URL=https://api.anthropic.com\n\n"
      + "ANTHROPIC_AUTH_TOKEN=real-claude-token\nexport OTHER_KEY=keep-me\n";
    fixture(initial);

    installHermesIntegration(defaultConfig("browser-only"));

    const text = readFileSync(getHermesEnvPath(), "utf8");
    expect(text.startsWith("\uFEFF# Hermes environment\n")).toBe(true);
    expect(text).toContain("ANTHROPIC_BASE_URL=https://api.anthropic.com\n");
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN=real-claude-token\n");
    expect(text).toContain("\n\n");
    expect(text).toContain("export OTHER_KEY=keep-me\n");
    expect(text.endsWith(`${HERMES_ENV_KEY}=${HERMES_ENV_MARKER}\n`)).toBe(true);
    expect(text.indexOf("ANTHROPIC_AUTH_TOKEN")).toBeLessThan(text.indexOf(HERMES_ENV_KEY));
  });

  test("keeps CRLF line endings", () => {
    const initial = "\uFEFF# hermes\r\nKEEP=1\r\n";
    fixture(initial);

    installHermesIntegration(defaultConfig("browser-only"));

    const text = readFileSync(getHermesEnvPath(), "utf8");
    expect(text.startsWith("\uFEFF# hermes\r\n")).toBe(true);
    expect(text).toContain("KEEP=1\r\n");
    expect(text).toContain(`${HERMES_ENV_KEY}=${HERMES_ENV_MARKER}\r\n`);

    uninstallHermesIntegration();
    expect(readFileSync(getHermesEnvPath(), "utf8")).toBe(initial);
  });

  test("re-installs idempotently and restores the user value it replaced", () => {
    const initial = "KEEP=1\nGPT_WEB_API_KEY=user-value\n";
    fixture(initial);
    const config = defaultConfig("browser-only");

    installHermesIntegration(config);
    expect(readFileSync(getHermesEnvPath(), "utf8")).toBe(`KEEP=1\n${HERMES_ENV_KEY}=${HERMES_ENV_MARKER}\n`);
    const afterFirstInstall = ownedFiles();

    installHermesIntegration(config);
    expect(ownedFiles()).toEqual(afterFirstInstall);
    expect(journal().previous.env[HERMES_ENV_KEY]).toEqual({ present: true, value: "user-value" });

    expect(uninstallHermesIntegration()).toEqual({ changed: true });
    expect(readFileSync(getHermesEnvPath(), "utf8")).toBe(initial);
  });

  test("refuses to overwrite a provider file edited after setup unless replacement is explicit", () => {
    fixture();
    const config = defaultConfig("browser-only");
    installHermesIntegration(config);
    writeFileSync(join(getHermesProviderDir(), "__init__.py"), "# edited by the user\n");

    expect(inspectHermesIntegrationStatus()).toBe("outdated");
    expect(() => preflightHermesIntegration(config)).toThrow("changed after setup");
    expect(() => installHermesIntegration(config)).toThrow("changed after setup");
    expect(readFileSync(join(getHermesProviderDir(), "__init__.py"), "utf8")).toBe("# edited by the user\n");

    installHermesIntegration(config, { replaceExistingRoute: true });
    expect(providerFile("__init__.py")).toContain("register_provider(gpt_web)");
    expect(inspectHermesIntegrationStatus()).toBe("installed");
  });

  test("never clobbers or deletes a marker key edited outside the integration", () => {
    fixture();
    const config = defaultConfig("browser-only");
    installHermesIntegration(config);
    const edited = readFileSync(getHermesEnvPath(), "utf8").replace(HERMES_ENV_MARKER, "user-token");
    writeFileSync(getHermesEnvPath(), edited);

    expect(inspectHermesIntegrationStatus()).toBe("outdated");
    expect(() => installHermesIntegration(config)).toThrow(`${HERMES_ENV_KEY} changed after setup`);
    expect(() => uninstallHermesIntegration()).toThrow(`${HERMES_ENV_KEY} changed after setup`);
    expect(readFileSync(getHermesEnvPath(), "utf8")).toBe(edited);
    expect(existsSync(getHermesProviderDir())).toBe(true);
  });

  test("uninstall restores exactly the files that existed before install", () => {
    const initial = "# note\nOTHER=1\n";
    fixture(initial);
    const before = ownedFiles();

    installHermesIntegration(defaultConfig("browser-only"));
    expect(inspectHermesIntegrationStatus()).toBe("installed");

    expect(uninstallHermesIntegration()).toEqual({ changed: true });

    expect(existsSync(getHermesProviderDir())).toBe(false);
    expect(readFileSync(getHermesEnvPath(), "utf8")).toBe(initial);
    expect(ownedFiles()).toEqual(before);
  });

  test("uninstall removes the .env and journal it created instead of leaving empty files", () => {
    fixture();

    installHermesIntegration(defaultConfig("browser-only"));
    uninstallHermesIntegration();

    expect(existsSync(getHermesEnvPath())).toBe(false);
    expect(existsSync(getHermesIntegrationJournalPath())).toBe(false);
    expect(inspectHermesIntegrationStatus()).toBe("missing");
  });

  test("does nothing when the integration was never installed", () => {
    fixture();

    expect(inspectHermesIntegrationStatus()).toBe("missing");
    expect(uninstallHermesIntegration()).toEqual({ changed: false });
    expect(() => preflightHermesIntegration(defaultConfig("browser-only"))).not.toThrow();
  });
});
