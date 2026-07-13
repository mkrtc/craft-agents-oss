# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Project Memory scope authorization** — Agent memory tools now reject cross-project IDs, derive location fields from the current server-side session context, and safely exclude unavailable project scopes instead of allowing model arguments to broaden access.

## Breaking Changes
