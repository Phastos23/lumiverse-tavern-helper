# Tavern Helper for Lumiverse

A port of [JS-Slash-Runner](https://github.com/n0vi028/JS-Slash-Runner) (Tavern-Helper) to Lumiverse as a Spindle extension.

## Install

1. Edit `github` and `homepage` in `spindle.json` to your repo URL.
2. `npm install && npm run build` (`dist/` must be committed).
3. Push to GitHub, then install it from Lumiverse's Extensions panel and grant the permissions.
4. Open the **Tavern Helper** drawer tab.

## Status

Phase 1: script library (enable/disable, folders, import of JS-Slash-Runner exports), the core `TavernHelper` API
(variables, chat messages, events, generate/generateRaw), console, diagnostics.
Not yet: message code-block rendering, worldbook/preset/persona/regex APIs, slash commands, audio.

Run `npm test` for the offline smoke tests.
