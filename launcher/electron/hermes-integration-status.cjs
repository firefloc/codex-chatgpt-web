const fs = require("node:fs");
const path = require("node:path");
const { readJsonFile } = require("./json-file.cjs");

const HERMES_ENV_KEY = "GPT_WEB_API_KEY";
const HERMES_PROVIDER_FILES = ["__init__.py", "plugin.yaml"];
const ENV_ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

function readEnvValue(raw, key) {
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = ENV_ASSIGNMENT.exec(line);
    if (match && match[2] === key) return line.slice(match[0].length);
  }
  return undefined;
}

/**
 * Mirrors inspectClaudeIntegrationStatus, but Hermes owns a plain `key=value` env file and a
 * provider directory instead of a JSON settings object. Terminal state is "installed" rather
 * than "current": there is no steering hook to keep synchronized, only files and one key.
 */
function inspectHermesIntegrationStatus({ journalPath, envPath, providerDir }) {
  if (!fs.existsSync(journalPath)) return "missing";
  try {
    const installed = readJsonFile(journalPath)?.installed;
    const value = installed?.env?.[HERMES_ENV_KEY];
    const files = installed?.files;
    if (typeof value !== "string" || !files || typeof files !== "object" || Array.isArray(files)) {
      return "outdated";
    }
    if (!fs.existsSync(envPath) || readEnvValue(fs.readFileSync(envPath, "utf8"), HERMES_ENV_KEY) !== value) {
      return "outdated";
    }
    return HERMES_PROVIDER_FILES.every(name => {
      if (typeof files[name] !== "string") return false;
      const filePath = path.join(providerDir, name);
      return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === files[name];
    }) ? "installed" : "outdated";
  } catch {
    return "outdated";
  }
}

function reconcileHermesSetupState(status) {
  return {
    hermesSetupComplete: status === "installed",
    hermesSetupOutdated: status === "outdated",
  };
}

module.exports = {
  HERMES_ENV_KEY,
  HERMES_PROVIDER_FILES,
  inspectHermesIntegrationStatus,
  reconcileHermesSetupState,
};
