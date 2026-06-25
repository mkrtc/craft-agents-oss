# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Linux AppImage installs now appear in application launchers** — The shell installer now registers a per-user desktop entry, extracts the app icon, refreshes desktop metadata, and registers the `craftagents://` handler. The generated Linux launcher also handles Wayland/Ozone startup flags and avoids broad process matching when replacing a running app. Packaged builds now stage the Session MCP and Pi agent subprocess bundles before electron-builder runs, so installed Pi-backed sessions can spawn the bundled subprocess instead of failing with a missing `piServerPath`.

## Breaking Changes
