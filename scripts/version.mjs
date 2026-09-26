// Works out the version of the next release and, with --write, puts it in package.json.
//
//   node scripts/version.mjs --bump minor            # prints the next version
//   node scripts/version.mjs --bump patch --write    # and writes it to package.json
//
// The base is the newest release tag in the repository (v1.2.3); with no tags yet the version in
// package.json is released as it stands, so the first release is the one the repo already declares.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string} value */
function isBump(value) {
  return value === "patch" || value === "minor" || value === "major";
}

/** Parses "v1.2.3" or "1.2.3"; anything else (pre-releases included) is not a release version. */
/** @param {string} value */
function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** @param {string} base @param {"patch"|"minor"|"major"} bump */
function nextVersion(base, bump) {
  const parsed = parseVersion(base);
  if (!parsed) throw new Error(`"${base}" is not a version like 1.2.3`);
  const [major, minor, patch] = parsed;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The newest release tag, by version order rather than by date. */
/** @param {string[]} tags */
function latestReleaseTag(tags) {
  const versions = tags
    .map((t) => ({ tag: t, v: parseVersion(t) }))
    .filter((x) => x.v !== undefined)
    .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return versions.at(-1)?.tag;
}

/**
 * @param {string[]} tags
 * @param {string} packageVersion
 * @param {"patch"|"minor"|"major"} bump
 */
function planRelease(tags, packageVersion, bump) {
  const latest = latestReleaseTag(tags);
  if (!latest) return { version: packageVersion, base: undefined, first: true };
  return { version: nextVersion(latest, bump), base: latest, first: false };
}

function gitTags() {
  try {
    return execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const bumpArg = args[args.indexOf("--bump") + 1] ?? "patch";
  if (!isBump(bumpArg)) {
    console.error(`--bump must be patch, minor or major (got "${bumpArg}")`);
    process.exit(2);
  }
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const plan = planRelease(gitTags(), pkg.version, bumpArg);
  if (args.includes("--write") && pkg.version !== plan.version) {
    // keep the files' formatting: only the version line changes. The plugin manifest carries the
    // same version so Claude Code picks up each release.
    for (const path of [pkgPath, join(here, "..", ".claude-plugin", "plugin.json")]) {
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${plan.version}$2`));
    }
    // The server reports its version from a constant in the entry point.
    const indexPath = join(here, "..", "src", "index.ts");
    const index = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, index.replace(/(const VERSION = ')[^']+(')/, `$1${plan.version}$2`));
  }
  if (args.includes("--github") && process.env.GITHUB_OUTPUT) {
    const out = [
      `version=${plan.version}`,
      `tag=v${plan.version}`,
      `base=${plan.base ?? ""}`,
      `first=${plan.first}`,
    ].join("\n");
    writeFileSync(process.env.GITHUB_OUTPUT, `${out}\n`, { flag: "a" });
  }
  console.log(plan.version);
}

export { isBump, parseVersion, nextVersion, latestReleaseTag, planRelease };
