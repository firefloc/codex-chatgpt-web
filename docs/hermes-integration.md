# Hermes integration

`codex-chatgpt-web hermes connect`, or **Install into Hermes** in the launcher, registers this
bridge as a model provider for [Hermes](https://hermes-agent.nousresearch.com). It writes exactly
two things and nothing else:

- `~/.hermes/.env` — one appended line, `GPT_WEB_API_KEY=codex-chatgpt-web-local`. That value is a
  local marker: the bridge only checks that the key is present. Every other line, comments, order,
  a UTF-8 BOM, and any `ANTHROPIC_*` entry are preserved. `~/.hermes/config.yaml` is never touched;
  Hermes discovers the provider and its nine models by itself, and the model is chosen with `/model`.
- `~/.hermes/plugins/model-providers/gpt-web/` — `__init__.py` and `plugin.yaml`, pointing at
  `http://<host>:<port>` from this project's configuration.

Restart Hermes, or reload its plugins, after connecting. `hermes status` reports `missing`,
`outdated`, or `installed`. `hermes disconnect` (or **Remove from Hermes**) deletes only the files
it installed, restores the previous `GPT_WEB_API_KEY` value, and refuses to touch either if they
were edited after installation.
