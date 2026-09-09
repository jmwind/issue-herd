// @weawr/protocol — the contracts every weawr client speaks. Portable: no Node-only imports.
// Filled in by the versioned CLI interface stage; the version is here from the start so the
// package boundary exists before anything depends on it.

/** The CLI interface version. Separate from the package version: additive changes stay within v1. */
export const PROTOCOL_VERSION = 1 as const;
