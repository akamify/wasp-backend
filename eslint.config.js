// ESLint architecture boundaries (scaffold).
// This repo currently doesn't ship ESLint dependencies for backend runtime.
// Keeping this file non-breaking: it only affects lint tooling when ESLint is installed/used.
module.exports = [
  {
    files: ["src/**/*.js"],
    rules: {
      // Prevent very deep relative imports (encourage aliases like @modules/*, @shared/*).
      // NOTE: Real enforcement requires eslint + eslint-plugin-import setup.
      // This is a placeholder to be wired once tooling is added.
    },
  },
];

