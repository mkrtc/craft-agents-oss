# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **More control over chat response density** — Appearance settings now let users auto-show model activity details only while a turn is running, and choose whether AI responses stay compact or allow the latest response to use full height. User-collapsed active activity details stay collapsed even as the final response message appears.

## Bug Fixes

- **Linux AppImage installs now appear in application launchers** — The shell installer now registers a per-user desktop entry, extracts the app icon, refreshes desktop metadata, and registers the `craftagents://` handler. Cold-start protocol links are now captured from Linux/Windows launch arguments instead of being dropped when the app was not already running. The generated Linux launcher also handles Wayland/Ozone startup flags and avoids broad process matching when replacing a running app. Packaged builds now stage the Session MCP and Pi agent subprocess bundles before electron-builder runs, so installed Pi-backed sessions can spawn the bundled subprocess instead of failing with a missing `piServerPath`.
- **Linux dark themes use an opaque app background** — Linux and WebUI builds now avoid macOS-style translucent backdrop assumptions, preventing dark sidebar/theme surfaces from blending against the native window background.

## Breaking Changes
