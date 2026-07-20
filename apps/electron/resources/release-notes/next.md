# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Safe restart updates** — Restart and update now cancels and awaits every active chat before handing control to the native updater, preventing in-flight turns and queued follow-ups from being cut off mid-shutdown.

## Breaking Changes
