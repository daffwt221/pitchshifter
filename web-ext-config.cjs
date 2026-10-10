// Keep dev-only files out of the packaged add-on.
module.exports = {
  ignoreFiles: [
    ".github",
    "diagnostics",
    "addon-under-test",
    "results",
    "store-listing.md",
    "screenshots",
    "web-ext-artifacts",
    "web-ext-config.cjs",
    "relatorio.md",
    "**/*Zone.Identifier",
  ],
};
