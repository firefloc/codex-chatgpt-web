import { existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, expandUserPath, getConfigDir, preserveUtf8Bom, stripUtf8Bom } from "./config";

/**
 * Hermes model-provider integration.
 *
 * Deliberately narrower than the Claude Code integration: Hermes has no gateway-wide route to
 * patch and no hooks, so there is no JSON settings file to edit. Hermes discovers model
 * providers by scanning its plugins directory, so this only writes the two provider files plus
 * one marker key in `~/.hermes/.env`. `~/.hermes/config.yaml` is intentionally never touched:
 * no YAML surgery, no model rewrite. The picker lists the bridge models on its own and the user
 * selects one with `/model`.
 */

export const HERMES_ENV_KEY = "GPT_WEB_API_KEY";
export const HERMES_ENV_MARKER = "codex-chatgpt-web-local";
export const HERMES_PROVIDER_FILES = ["__init__.py", "plugin.yaml"] as const;
export const HERMES_INTEGRATION_STATUSES = ["missing", "outdated", "installed"] as const;

export type HermesIntegrationStatus = (typeof HERMES_INTEGRATION_STATUSES)[number];

interface PreviousValue {
  present: boolean;
  value?: string;
}

export interface HermesIntegrationJournal {
  version: 1;
  envPath: string;
  envExisted: boolean;
  providerDir: string;
  installed: {
    env: Record<string, string>;
    files: Record<string, string>;
  };
  previous: {
    env: Record<string, PreviousValue>;
  };
}

export interface InstallHermesIntegrationOptions {
  replaceExistingRoute?: boolean;
}

interface FileSnapshot {
  path: string;
  exists: boolean;
  data?: Buffer;
}

const ENV_ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

function envLineBreak(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function readEnvValue(raw: string, key: string): PreviousValue {
  for (const line of stripUtf8Bom(raw).split(/\r?\n/)) {
    const match = ENV_ASSIGNMENT.exec(line);
    if (match && match[2] === key) return { present: true, value: line.slice(match[0].length) };
  }
  return { present: false };
}

function writeEnvValue(raw: string, key: string, value: string): string {
  const eol = envLineBreak(raw);
  let body = stripUtf8Bom(raw);
  if (body !== "" && !body.endsWith(eol)) body += eol;
  const lines = body.split(eol);
  let replaced = false;
  const next = lines.map(line => {
    const match = ENV_ASSIGNMENT.exec(line);
    if (!match || match[2] !== key) return line;
    replaced = true;
    return `${line.slice(0, match[0].length)}${value}`;
  });
  if (!replaced) next.splice(lines.length - 1, 0, `${key}=${value}`);
  return preserveUtf8Bom(next.join(eol), raw);
}

function removeEnvValue(raw: string, key: string): string {
  const eol = envLineBreak(raw);
  const next = stripUtf8Bom(raw).split(eol).filter(line => {
    const match = ENV_ASSIGNMENT.exec(line);
    return !match || match[2] !== key;
  });
  return preserveUtf8Bom(next.join(eol), raw);
}

function readEnvFile(path: string): { exists: boolean; raw: string } {
  return existsSync(path) ? { exists: true, raw: readFileSync(path, "utf8") } : { exists: false, raw: "" };
}

// Byte-for-byte copy of the live provider plugin that ships with this bridge; only `base_url`
// is parameterized. Do not hand-edit: regenerate from the installed plugin when it changes.
const PROVIDER_INIT_TEMPLATE = `"""ChatGPT Web — les modeles du bridge local codex-chatgpt-web.

Le bridge n'expose QUE \`\`POST /v1/messages\`\` (Anthropic Messages) : \`\`/v1/chat/completions\`\`
repond 404 « Chat Completions is disabled » et \`\`GET /v1/models\`\` exige l'OAuth ChatGPT.
D'ou \`\`api_mode="anthropic_messages"\`\`, aucun listing live, et un catalogue en dur.
La cle est un simple marqueur local : le bridge ne verifie que sa presence.
"""

from providers import register_provider
from providers.base import ProviderProfile

# Catalogue lu dans ~/.codex/models_cache.json (le bridge ne peut pas le servir).
# Les 4 premiers sont ceux que le launcher affiche ; les 5 suivants sont les
# variantes d'effort, masquees dans le launcher mais servies par le bridge.
_MODELS: tuple = (
    "chatgpt-web/gpt-6-pro",
    "chatgpt-web/gpt-5.6-pro",
    "chatgpt-web/gpt-5.6-sol",
    "chatgpt-web/gpt-5.6-sol-instant",
    "chatgpt-web/pro",
    "chatgpt-web/high",
    "chatgpt-web/extra-high",
    "chatgpt-web/medium",
    "chatgpt-web/light",
)

gpt_web = ProviderProfile(
    name="gpt-web",
    aliases=("gptweb", "chatgpt-web"),
    api_mode="anthropic_messages",
    env_vars=("GPT_WEB_API_KEY",),
    base_url="__BASE_URL__",
    display_name="ChatGPT Web (bridge)",
    description="Modeles Web ChatGPT via le bridge local codex-chatgpt-web",
    auth_type="api_key",
    # GET /v1/models repond 502/400 (OAuth ChatGPT requis) : pas de sonde, pas de listing.
    supports_health_check=False,
    supports_model_listing=False,
    fallback_models=_MODELS,
)

register_provider(gpt_web)
`;
const PROVIDER_PLUGIN_SOURCE = `name: gpt-web-provider
kind: model-provider
version: 1.0.0
description: Modeles Web ChatGPT via le bridge local codex-chatgpt-web
author: Florian
`;

function desired(config: AppConfig): HermesIntegrationJournal["installed"] {
  const baseUrl = `http://${config.host}:${config.port}`;
  return {
    env: { [HERMES_ENV_KEY]: HERMES_ENV_MARKER },
    files: {
      "__init__.py": PROVIDER_INIT_TEMPLATE.replace("__BASE_URL__", baseUrl),
      "plugin.yaml": PROVIDER_PLUGIN_SOURCE,
    },
  };
}

function snapshot(path: string): FileSnapshot {
  return existsSync(path) ? { path, exists: true, data: readFileSync(path) } : { path, exists: false };
}

function restoreSnapshot(file: FileSnapshot): void {
  if (file.exists) atomicWriteFile(file.path, file.data!);
  else rmSync(file.path, { force: true });
}

/** Removes a directory only when it is already empty, never its contents. */
function removeEmptyDirectory(path: string): void {
  try { rmdirSync(path); } catch { /* Directory is non-empty or absent: leave it alone. */ }
}

function carryForward(current: PreviousValue, installedValue?: string, existingPrevious?: PreviousValue): PreviousValue {
  return installedValue !== undefined && existingPrevious && current.present && current.value === installedValue
    ? existingPrevious
    : current;
}

function writeWithCompensation(
  envPath: string,
  envRaw: string,
  files: Record<string, string>,
  journal: HermesIntegrationJournal,
): void {
  const providerDir = getHermesProviderDir();
  const targets = [
    envPath,
    ...Object.keys(files).map(name => join(providerDir, name)),
    getHermesIntegrationJournalPath(),
  ];
  const snapshots = targets.map(snapshot);
  try {
    atomicWriteFile(envPath, envRaw);
    for (const [name, content] of Object.entries(files)) atomicWriteFile(join(providerDir, name), content);
    atomicWriteFile(getHermesIntegrationJournalPath(), `${JSON.stringify(journal, null, 2)}\n`);
  } catch (error) {
    const failures: string[] = [];
    for (const file of snapshots.reverse()) {
      try { restoreSnapshot(file); } catch (caught) { failures.push(`${file.path}: ${String(caught)}`); }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(
      failures.length > 0 ? `${primary}; Hermes integration rollback failed: ${failures.join("; ")}` : primary,
    );
  }
}

function readJournal(): HermesIntegrationJournal | undefined {
  const path = getHermesIntegrationJournalPath();
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))) as Partial<HermesIntegrationJournal>;
  if (value.version !== 1
    || typeof value.envPath !== "string"
    || typeof value.providerDir !== "string"
    || !value.installed
    || !value.previous) {
    throw new Error(`Unsupported Hermes integration journal: ${path}`);
  }
  const journal = value as HermesIntegrationJournal;
  // The journal is machine-wide but records the Hermes home it was written for. A journal for
  // another home describes that home, so here it reads as absent: status reports "missing" and
  // install/preflight start fresh for this home instead of raising "belongs to".
  return identity(journal.envPath) === identity(getHermesEnvPath()) ? journal : undefined;
}

function identity(value: string): string {
  return process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
}

function assertJournalPath(journal: HermesIntegrationJournal, path: string): void {
  if (identity(journal.envPath) !== identity(path)) {
    throw new Error(`Hermes integration journal belongs to ${journal.envPath}, not ${path}`);
  }
}

function assertInstalled(raw: string, journal: HermesIntegrationJournal): void {
  for (const [key, value] of Object.entries(journal.installed.env)) {
    const current = readEnvValue(raw, key);
    if (!current.present || current.value !== value) throw new Error(`Hermes ${key} changed after setup`);
  }
  for (const [name, content] of Object.entries(journal.installed.files)) {
    const path = join(getHermesProviderDir(), name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      throw new Error(`Hermes provider file ${name} changed after setup`);
    }
  }
}

export function getHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".hermes")));
}

export function getHermesEnvPath(): string {
  return join(getHermesHome(), ".env");
}

export function getHermesProviderDir(): string {
  return join(getHermesHome(), "plugins", "model-providers", "gpt-web");
}

export function getHermesIntegrationJournalPath(): string {
  return join(getConfigDir(), "hermes", "integration-journal.json");
}

export function inspectHermesIntegrationStatus(): HermesIntegrationStatus {
  if (!existsSync(getHermesIntegrationJournalPath())) return "missing";
  let journal: HermesIntegrationJournal;
  try {
    const parsed = readJournal();
    if (!parsed) return "missing";
    journal = parsed;
  } catch {
    return "outdated";
  }
  const current = readEnvFile(getHermesEnvPath());
  if (!current.exists) return "outdated";
  try {
    assertInstalled(current.raw, journal);
  } catch {
    return "outdated";
  }
  return "installed";
}

export function preflightHermesIntegration(
  _config: AppConfig,
  options: InstallHermesIntegrationOptions = {},
): void {
  const envPath = getHermesEnvPath();
  const current = readEnvFile(envPath);
  const journal = readJournal();
  if (!journal) return;
  assertJournalPath(journal, envPath);
  if (!current.exists && options.replaceExistingRoute !== true) {
    throw new Error(`Hermes environment file is missing: ${envPath}`);
  }
  if (current.exists && options.replaceExistingRoute !== true) assertInstalled(current.raw, journal);
}

export function installHermesIntegration(
  config: AppConfig,
  options: InstallHermesIntegrationOptions = {},
): HermesIntegrationJournal {
  const envPath = getHermesEnvPath();
  const current = readEnvFile(envPath);
  const existing = readJournal();
  if (existing) assertJournalPath(existing, envPath);
  if (existing && !current.exists && options.replaceExistingRoute !== true) {
    throw new Error(`Hermes environment file is missing: ${envPath}`);
  }
  if (existing && options.replaceExistingRoute !== true) assertInstalled(current.raw, existing);

  const installed = desired(config);
  const previous = {
    env: Object.fromEntries(Object.keys(installed.env).map(key => [
      key,
      carryForward(readEnvValue(current.raw, key), existing?.installed.env[key], existing?.previous.env[key]),
    ])),
  };
  let raw = current.raw;
  for (const [key, value] of Object.entries(installed.env)) raw = writeEnvValue(raw, key, value);
  const journal: HermesIntegrationJournal = {
    version: 1,
    envPath,
    envExisted: existing?.envExisted ?? current.exists,
    providerDir: getHermesProviderDir(),
    installed,
    previous,
  };
  writeWithCompensation(envPath, raw, installed.files, journal);
  return journal;
}

export function uninstallHermesIntegration(): { changed: boolean } {
  const journal = readJournal();
  if (!journal) return { changed: false };
  const envPath = getHermesEnvPath();
  assertJournalPath(journal, envPath);
  const current = readEnvFile(envPath);
  if (!current.exists) throw new Error(`Hermes environment file is missing: ${envPath}`);
  assertInstalled(current.raw, journal);

  let raw = current.raw;
  for (const [key, previous] of Object.entries(journal.previous.env)) {
    raw = previous.present && typeof previous.value === "string"
      ? writeEnvValue(raw, key, previous.value)
      : removeEnvValue(raw, key);
  }

  const providerDir = getHermesProviderDir();
  const snapshots = [
    snapshot(envPath),
    ...HERMES_PROVIDER_FILES.map(name => snapshot(join(providerDir, name))),
    snapshot(getHermesIntegrationJournalPath()),
  ];
  try {
    if (!journal.envExisted && stripUtf8Bom(raw).trim() === "") rmSync(envPath, { force: true });
    else atomicWriteFile(envPath, raw);
    for (const name of HERMES_PROVIDER_FILES) rmSync(join(providerDir, name), { force: true });
    removeEmptyDirectory(providerDir);
    removeEmptyDirectory(join(getHermesHome(), "plugins", "model-providers"));
    removeEmptyDirectory(join(getHermesHome(), "plugins"));
    rmSync(getHermesIntegrationJournalPath(), { force: true });
    removeEmptyDirectory(join(getConfigDir(), "hermes"));
  } catch (error) {
    for (const file of snapshots.reverse()) restoreSnapshot(file);
    throw error;
  }
  return { changed: true };
}
