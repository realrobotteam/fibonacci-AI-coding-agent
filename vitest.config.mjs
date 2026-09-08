// Unit tests for pure host-side logic (parsers, budgeting, SSRF checks).
// Plain .mjs + no TS so the native config loader doesn't complain, and the
// update check is disabled via VITEST_SKIP_UPDATE_CHECK in the npm script.
export default {
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No coverage/UI — keep runs fast and non-interactive.
    watch: false,
  },
};
