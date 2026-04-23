/**
 * Error-name constants shared across packages.
 *
 * `@pm-go/contracts` is the one package every other workspace member
 * already depends on, so putting stable error-name strings here avoids
 * both:
 *   - duplicating the literal between producer (`@pm-go/executor-claude`)
 *     and consumer (`@pm-go/temporal-workflows`), which invites drift; and
 *   - adding a direct `executor-claude` dep to `temporal-workflows`, which
 *     would pull heavy SDK runtime code into the Temporal workflow
 *     sandbox where it does not belong.
 *
 * Each constant here is only the NAME an `Error` instance carries on its
 * `.name` property. The thrown error class itself (and any class-specific
 * behaviour) stays in the package that owns the failure mode.
 */

/**
 * `.name` of the executor-side error thrown when the model's response
 * is blocked by the provider's content-filter / safety layer. Used by:
 *   - `@pm-go/executor-claude/src/errors.ts` — producer (sets this on
 *     the thrown `ContentFilterError`).
 *   - `@pm-go/temporal-workflows/src/definitions.ts` — consumer
 *     (includes it in `nonRetryableErrorNames` so Temporal short-circuits
 *     retries on a deterministically-blocked prompt).
 */
export const CONTENT_FILTER_ERROR_NAME = "ContentFilterError" as const;
