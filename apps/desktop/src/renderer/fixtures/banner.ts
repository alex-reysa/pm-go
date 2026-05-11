/**
 * M2 mock-fixture banner string.
 *
 * Every route that consumes a fixture dataset MUST render this label
 * somewhere visible to the operator. The point is to make the
 * "this is mock data, not live API state" disclaimer impossible to
 * miss — the M2 cockpit and run-detail surfaces are intentionally
 * deceptive-looking (real shapes, plausible counts, realistic
 * status badges) so that the IA can be exercised end-to-end before
 * M3 lights up the API client. Without the banner, an operator
 * could easily mistake the fixture for live state and act on it.
 *
 * The literal copy is fixed: "fixture: mocked — replace in M3". M3
 * will remove the consumers of this constant on a per-route basis
 * as each surface migrates to live calls.
 */
export const FIXTURE_BANNER_LABEL = "fixture: mocked — replace in M3" as const;

/**
 * The literal type of {@link FIXTURE_BANNER_LABEL}. Useful for
 * downstream consumers that want to assert at the type level that
 * a UI banner string is the canonical fixture label rather than an
 * arbitrary string the renderer happened to pass through.
 */
export type FixtureBannerLabel = typeof FIXTURE_BANNER_LABEL;
