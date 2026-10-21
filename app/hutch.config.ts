// Package installs go through Bun (bun.lock + the 1-day minimumReleaseAge in
// bunfig.toml), never Hutch's built-in resolver, which ignores both.
export default {
  packageManager: "bun",
};
