// Keep dev-only files out of the packaged add-on.
module.exports = {
  ignoreFiles: [
    "store-listing.md",
    "screenshots",
    "web-ext-artifacts",
    "web-ext-config.cjs",
    "**/*Zone.Identifier",
  ],
};
