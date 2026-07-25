---
name: git-review
description: Reviews a pull request diff for correctness and style. Use this when the user asks for a code review, wants feedback on a branch, or pastes a diff and asks what is wrong with it.
---

# Git review

Read the diff, then report findings most severe first.

1. Fetch the diff with `git diff main...HEAD`.
2. Flag correctness bugs before style ones.
3. Quote the offending line for each finding.
