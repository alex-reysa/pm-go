# Worktree Manager

This package will own all branch and worktree operations.

Rules:

- one task equals one branch
- one write-capable agent equals one worktree
- branch names must be deterministic
- reviewers are read-only
- dirty worktrees trigger escalation, not cleanup

