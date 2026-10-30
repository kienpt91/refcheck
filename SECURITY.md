# Security

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or email kienphan.dev@gmail.com. Do not file public issues for vulnerabilities.

## Trust model

- `refcheck` reads source files, `package.json` files, `tsconfig.json` and `node_modules` type declarations. It never executes code from the project and never uses the network. JSON inputs larger than 5 MiB (1 MiB for the config) are ignored or rejected.
- `refcheck.config.json` is plain JSON, validated strictly, and cannot load code. It can, however, switch rules off or exclude paths, so in a pull-request workflow treat changes to it as security-relevant.
- `refcheck hook install` writes one file. It stays inside the repository unless `--allow-external-hooks-path` is given, backs up a replaced hook, and never writes through a symlink.
- Paths taken from package metadata (`exports` targets, import subpaths, workspace globs) are not followed outside the package or project root.
- Config glob patterns are limited to 256 characters and runs of `*` are collapsed, which bounds regular-expression backtracking.

## Dependency policy

Every dependency version, direct and transitive, is installed with `npm install --ignore-scripts --before=<cutoff>` where the cutoff is 7 days before the change. A version published inside that window is not used, even when it carries an advisory fix. Installs, tests, typechecks and builds run inside a throwaway container, never directly on a developer host, and CI uses `npm ci --ignore-scripts`. No dependency needs an install script (the only one in the lockfile is the optional macOS `fsevents`, which is not required). The only runtime dependency of the published package is `typescript` (exact version pinned in `package.json`); everything else is a development dependency and is not shipped (`files` is limited to `dist`). `.github/dependabot.yml` uses a 7-day cooldown.

## Open advisories

As of the dependency cutoff (2026-10-23), `npm audit` reports no advisories, with or without `--omit=dev`.
