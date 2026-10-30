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

Every dependency version, direct and transitive, is installed with `npm install --before=<cutoff>` where the cutoff is 30 days before the change. A version published inside that window is not used, even when it carries an advisory fix. The only runtime dependency of the published package is `typescript` (exact version pinned in `package.json`); everything else is a development dependency and is not shipped (`files` is limited to `dist`).

## Open advisories

`npm audit` reports the following advisories against development dependencies. The fixed versions were published after the dependency cutoff (2026-09-30) or require a major upgrade of the test runner, so they are deliberately not taken yet.

| Package (locked) | Advisories | Fixed in | Reachability |
| --- | --- | --- | --- |
| `vite` 7.3.6 (and its `launch-editor`) | GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm | `vite` 7.3.7 (published 2026-10-06) | Dev-server middleware and editor-launch issues. `vitest run` does not start the Vite dev server or open editors, and the tests serve no browser content. Not reachable from the published package. |
| `source-map-js` 1.2.1 | GHSA-68fv-2mgg-jv7q | `source-map-js` 1.2.2 (published 2026-09-30T14:08Z, after the cutoff) | Denial of service when parsing a crafted indexed source map through `postcss`. This project processes no CSS and no untrusted source maps. |
| `tinypool` 1.1.1 | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | `tinypool` 2.1.2 and later, which needs `vitest` 5 | Prototype pollution through worker options. The options are fixed by vitest's own configuration, not by external input. Test-time only. |
| `vitest` 3.2.7 / `@vitest/mocker` 3.2.7 | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | `vitest` 4.1.12 or 5.0.5 (published 2026-10-15) | Mock registration and redirect-mock issues. The test suite uses no mocks and does not load untrusted test files. Test-time only. |

Run the tests only on code you trust. Revisit this table when the cutoff moves past the fixed releases.
