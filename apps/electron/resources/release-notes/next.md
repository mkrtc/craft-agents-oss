# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- Added custom chat groups: create lightweight workspace groups, assign chats from the session menu, and group the sidebar by those custom groups.
- Added workspace-level AI account controls: enable only selected authorized LLM connections per workspace so chats and spawned agents cannot accidentally use disabled accounts.

## Improvements

- Improved recovery for chats whose AI account was removed or disabled for the workspace: the model picker now offers a clear continue-with-enabled-account action.

## Bug Fixes

- Fixed Continue With recovery when the source chat's AI account has been disabled for the workspace; the selected destination account is now the only account that must be enabled.

## Breaking Changes
