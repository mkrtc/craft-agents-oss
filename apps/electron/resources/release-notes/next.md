# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Safe workspace detach** — Removing a workspace now waits for active sessions, tasks, background operations, automations, and messaging work to finish; tears down workspace-owned runtimes before detaching configuration; preserves all session and project files; and reports actionable, localized retry guidance.
- **Visible file-watch fallback** — The session file panel now reports when descriptor limits force periodic polling or manual refresh, with a direct Refresh action when automatic updates are unavailable.

## Bug Fixes

## Breaking Changes
