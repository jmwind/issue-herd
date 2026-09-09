// @weawr/recipes — what a factory tells its agents, as versioned templates.
// Stage 1 ships the prompt files (dist/prompts); rendering and resolution move here when the
// engine is extracted. No filesystem access in this package: callers pass template text in.

/** The prompt templates bundled with weawr, by file name under dist/prompts. */
export const BUNDLED_PROMPTS = ['default.md', 'review-lead.md', 'review-security.md', 'review-usability.md', 'smoke.md', 'instructions.example.md'] as const;
