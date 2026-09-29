const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  inspectHermesIntegrationStatus,
  reconcileHermesSetupState,
} = require("../electron/hermes-integration-status.cjs");

const ENV_KEY = "GPT_WEB_API_KEY";
const MARKER = "codex-chatgpt-web-local";
const PROVIDER_FILES = ["__init__.py", "plugin.yaml"];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-hermes-status-"));
  const providerDir = path.join(root, "plugins", "model-providers", "gpt-web");
  fs.mkdirSync(providerDir, { recursive: true });
  const files = { "__init__.py": "register_provider(gpt_web)\n", "plugin.yaml": "name: gpt-web-provider\n" };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(providerDir, name), content);
  fs.writeFileSync(path.join(root, ".env"), `KEEP=1\n${ENV_KEY}=${MARKER}\n`);
  const journalPath = path.join(root, "hermes", "integration-journal.json");
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, `${JSON.stringify({
    version: 1,
    envPath: path.join(root, ".env"),
    providerDir,
    installed: { env: { [ENV_KEY]: MARKER }, files },
    previous: { env: { [ENV_KEY]: { present: false } } },
  }, null, 2)}\n`);
  return { root, journalPath, envPath: path.join(root, ".env"), providerDir, files };
}

test("does not claim a provider directory without a managed journal", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));

  fs.rmSync(files.journalPath, { force: true });
  assert.equal(inspectHermesIntegrationStatus(files), "missing");
});

test("reads a journal recorded for another Hermes home as missing", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));

  const journal = JSON.parse(fs.readFileSync(files.journalPath, "utf8"));
  journal.envPath = path.join(files.root, "other-home", ".env");
  fs.writeFileSync(files.journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  assert.equal(inspectHermesIntegrationStatus(files), "missing");
});

test("marks a drifted key, a drifted provider file, or a missing .env as outdated", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));

  fs.writeFileSync(files.envPath, `KEEP=1\n${ENV_KEY}=user-token\n`);
  assert.equal(inspectHermesIntegrationStatus(files), "outdated");

  fs.writeFileSync(files.envPath, `KEEP=1\n${ENV_KEY}=${MARKER}\n`);
  fs.writeFileSync(path.join(files.providerDir, "plugin.yaml"), "name: edited\n");
  assert.equal(inspectHermesIntegrationStatus(files), "outdated");

  fs.writeFileSync(path.join(files.providerDir, "plugin.yaml"), files.files["plugin.yaml"]);
  fs.rmSync(files.envPath, { force: true });
  assert.equal(inspectHermesIntegrationStatus(files), "outdated");
});

test("reports installed for an untouched integration and tolerates a BOM and CRLF", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));

  assert.equal(inspectHermesIntegrationStatus(files), "installed");

  fs.writeFileSync(files.envPath, `\uFEFFKEEP=1\r\n${ENV_KEY}=${MARKER}\r\n`);
  assert.equal(inspectHermesIntegrationStatus(files), "installed");
});

test("treats a corrupt journal as outdated instead of throwing", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));

  fs.writeFileSync(files.journalPath, "{ not json");
  assert.equal(inspectHermesIntegrationStatus(files), "outdated");
});

test("reconciles launcher state without silently repairing files", () => {
  assert.deepEqual(reconcileHermesSetupState("outdated"), {
    hermesSetupComplete: false,
    hermesSetupOutdated: true,
  });
  assert.deepEqual(reconcileHermesSetupState("installed"), {
    hermesSetupComplete: true,
    hermesSetupOutdated: false,
  });
  assert.deepEqual(reconcileHermesSetupState("missing"), {
    hermesSetupComplete: false,
    hermesSetupOutdated: false,
  });
});

test("wires actual provider status into snapshot and the reinstall action", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");

  assert.match(main, /runtimeHost\?\.hermesIntegrationStatus\(\)/);
  assert.match(main, /stateStore\.update\(hermes\)/);
  assert.match(main, /handle\("launcher:setup-hermes", \(\) => hermesIntegration\(true\)\)/);
  assert.match(main, /handle\("launcher:disconnect-hermes", \(\) => hermesIntegration\(false\)\)/);
  assert.match(app, /hermesSetupComplete \|\| snapshot\.state\.hermesSetupOutdated/);
});
