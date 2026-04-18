export type RepoIntelligenceErrorCode =
  | "not-a-directory"
  | "not-a-git-repo"
  | "git-command-failed"
  | "malformed-package-json";

export class RepoIntelligenceError extends Error {
  readonly code: RepoIntelligenceErrorCode;

  constructor(code: RepoIntelligenceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepoIntelligenceError";
    this.code = code;
  }
}
