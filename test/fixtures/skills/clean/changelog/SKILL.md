---
name: changelog
description: Drafts release notes from commit history. Use when the user is cutting a release, asks what changed since a tag, or wants a summary of recent work written for end users.
---

# Changelog

Group commits by user-visible effect, not by author or file.

1. Read `git log <last-tag>..HEAD`.
2. Drop refactors and test-only commits.
3. Write each entry as something a user would notice.
