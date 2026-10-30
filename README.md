# refcheck

**A local, deterministic checker that verifies the imports, exports, subpaths and call shapes in your JavaScript/TypeScript code against what is actually installed in `node_modules`.** No LLM, no network, no hosted index.

```
$ refcheck check cases/exp-01-invented-named.ts
cases/exp-01-invented-named.ts
  2:10  error  "postJson" is not exported by "tiny-http"  missing-export
                 did you mean "post"?
```

It is meant to be run by humans, git hooks, CI, or by coding agents as a tool (`refcheck check --json`).

## Why

Coding agents write code against their memory of a library, not against the version in your lockfile. The usual failures are mechanical: an import that does not exist (`import { postJson } from "tiny-http"`), a package name that is slightly off or invented, a deep import that the package's `exports` map forbids, an options key that is mis-cased (`timeOut`), a function called with the wrong number of arguments, or an API that the installed version already marks `@deprecated`.

Most tools that address this retrieve documentation, or ask another model to judge the code. Both can be wrong in the same way the author was. These failures can be decided by reading the installed package: its `package.json` `exports`, its type declarations, its JSDoc. `refcheck` does that, with the TypeScript compiler API, and nothing else. The same input always gives the same answer.

Invented package names are also a supply-chain problem: attackers register names that models tend to make up, and a pasted `npm install` then installs them. `unknown-package` flags any import that is neither declared in `package.json`, nor a Node builtin, nor a workspace package, and says so when the name is not installed either.

## Install

```
npm install --save-dev refcheck
npx refcheck --help
```

Requires Node 20 or newer. `refcheck` bundles its own `typescript` for analysis; it does not use the version in your project (your `node_modules` packages are only read, never executed).

## Usage

```
refcheck check [paths...] [--all] [--staged] [--json] [--root <dir>] [--config <file>] [--no-color]
refcheck hook install [--force] [--allow-external-hooks-path] [--root <dir>]
```

Which files are checked:

| Invocation | Files |
| --- | --- |
| `refcheck check` | files changed versus `HEAD` (staged, unstaged, untracked; deleted files excluded) |
| `refcheck check --staged` | files staged for commit |
| `refcheck check src lib/a.ts` | the given files and directories |
| `refcheck check --all` | every source file under the root, skipping `node_modules`, `dist`, `build`, `coverage`, `out` and dot directories |

Source files are `.ts .tsx .js .jsx .mts .cts .mjs .cjs` (not `.d.ts`). The root is the current directory unless `--root` is given, and must contain a `package.json`.

Exit codes: `0` no errors (warnings allowed), `1` at least one error, `2` usage or internal error (bad flag, unknown path, invalid config, not a git repository in default mode).

Human output is grouped by file and colored only on a TTY (`NO_COLOR` and `--no-color` disable it). Real output from this repository's benchmark project:

```
$ refcheck check cases/arity-02-too-many.ts cases/dep-01-function.ts cases/exp-01-invented-named.ts cases/opt-01-wrong-case.ts cases/pkg-01-typo.ts
cases/arity-02-too-many.ts
  4:18  error    get() called with 3 arguments, but it accepts 1-2  bad-call-arity

cases/dep-01-function.ts
  4:18  warning  "fetchUrl" is deprecated: Use `get` instead; fetchUrl ignores redirects.  deprecated-api

cases/exp-01-invented-named.ts
  2:10  error    "postJson" is not exported by "tiny-http"  missing-export
                 did you mean "post"?

cases/opt-01-wrong-case.ts
  4:57  error    Unknown option "timeOut" passed to createClient()  unknown-option-key
                 did you mean "timeout"?

cases/pkg-01-typo.ts
  2:21  error    "tiny-htpp" is not declared in package.json and not installed; the package may not exist (typo or invented name; importing unknown names is a supply-chain risk)  unknown-package
                 did you mean "tiny-http"?

refcheck: 5 files checked, 4 errors, 1 warning
```

## Rules

| Rule | Default | What it catches |
| --- | --- | --- |
| `unknown-package` | error | A bare import that is not in `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies` of the `package.json` files between the file and the root, not a Node builtin, not a workspace package, not a `tsconfig` `paths`/`baseUrl` alias. Suggests a close declared name. Also reported when the package is installed only as a transitive dependency. A package declared only through `@types/x` counts as declared. |
| `not-installed` | warning | Declared in `package.json` but missing from `node_modules`, so nothing else about it can be verified. |
| `unresolved-subpath` | error | `import "pkg/sub"` that the package's `exports` map does not allow (missing key, `null` target, no matching `import`/`require` condition, pattern whose target file does not exist). Without an `exports` map, the file layout is checked. |
| `missing-export` | error | A named import, `export { x } from`, namespace member (`ns.x` after `import * as ns`) or default import that the resolved declaration file does not export. Follows `export *`, re-exports, `export =` with merged namespaces and type-only exports. |
| `bad-call-arity` | error | A call or `new` whose resolved signatures cannot take that many arguments, across all overloads, with optional, rest and trailing-`void` parameters considered. Skipped when the call has spread arguments. |
| `unknown-option-key` | error | An object literal argument with keys that the parameter's (non-index-signature) object type does not have; nested literals are checked too. Suggests the closest valid key. |
| `deprecated-api` | warning | Use of a symbol, overload or option key whose declaration carries a JSDoc `@deprecated`, with the deprecation message. |
| `relative-import-missing` | error | A relative import or re-export whose file does not exist (extension, `.js` to `.ts`, and `index` resolution are handled). |

`bad-call-arity`, `unknown-option-key` and `deprecated-api` apply to declarations that live in typed files under `node_modules`; calls into your own code and the standard library are left to the TypeScript compiler.

## JSON output (for tools and agents)

`refcheck check --json` prints exactly one JSON object on stdout:

```json
{
  "version": 1,
  "root": "/abs/path/to/project",
  "filesChecked": 1,
  "findings": [
    {
      "rule": "unknown-option-key",
      "severity": "error",
      "file": "cases/opt-03-nested-key.ts",
      "line": 4,
      "column": 65,
      "message": "Unknown option \"username\" passed to createClient() option \"auth\"; did you mean \"user\"?",
      "package": "tiny-http",
      "symbol": "username",
      "suggestion": "user"
    }
  ],
  "summary": { "errors": 1, "warnings": 0 }
}
```

`file` is relative to `root` with `/` separators; `line` and `column` are 1-based; `package`, `symbol` and `suggestion` are present when known. The exit code follows the table above, so a tool can use either the code or the JSON. Nothing but this object is written to stdout.

## Using it with coding agents

Give the agent a command, not a plugin: "after editing, run `npx refcheck check --json` and fix every `error` finding". The `suggestion` field tells it the likely intended name, and `message` states what the installed package does not provide. There is no server and no MCP configuration. Because the analysis is local and takes tens to hundreds of milliseconds on a small project, it can run after every edit.

## Git pre-commit hook

Install one with:

```
$ refcheck hook install
Installed pre-commit hook: /path/to/repo/.git/hooks/pre-commit
```

The hook is a two-line shell script (`exec npx --no-install refcheck check --staged`). It checks the files as they are in the working tree, not the staged blobs. The install is deliberately conservative:

- The resolved path is always printed.
- An existing `pre-commit` entry, including a dangling symlink, is never overwritten without `--force`. With `--force` the old hook is moved to `pre-commit.bak` (a symlink is moved as a symlink, never written through). If `pre-commit.bak` already exists, the command refuses.
- `core.hooksPath` is honored, but only when the hooks directory is inside the repository (or its git directory, after resolving symlinks). A directory outside it, such as a shared hooks directory set in your global git config, is refused with a message naming the path and the config scope; pass `--allow-external-hooks-path` to install there anyway. Such a directory may apply to other repositories, and the command says so.

Copy-paste alternative, if you manage hooks yourself:

```sh
#!/bin/sh
exec npx --no-install refcheck check --staged
```

## CI step

Check the whole tree:

```yaml
- run: npm ci
- run: npx refcheck check --all
```

Or only what a pull request changed (needs full history, `fetch-depth: 0`): pass the files explicitly.

```yaml
- run: npx refcheck check $(git diff --name-only --diff-filter=ACMR origin/main...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.mts' '*.cts')
```

Warnings do not fail the job; set `"severity": { "deprecated-api": "error" }` in the config if they should.

## Configuration

`refcheck.config.json` in the root (or `--config <file>`). Unknown keys and unknown rule names are rejected with exit `2`.

```json
{
  "ignoreRules": ["not-installed"],
  "ignorePaths": ["**/*.generated.ts", "scripts/"],
  "ignorePackages": ["virtual-module"],
  "severity": { "deprecated-api": "error", "unknown-option-key": "warning" }
}
```

- `ignoreRules`: rules that are never reported.
- `ignorePaths`: globs relative to the root (`*`, `**`, `?`; a pattern without `/` matches the file name at any depth; a trailing `/` matches a directory).
- `ignorePackages`: findings that concern these packages are dropped.
- `severity`: per rule `"error"`, `"warning"` or `"off"`.

### Inline suppression

A comment on the previous line suppresses the named rules for the whole statement that follows; a trailing comment suppresses its own line. A bare directive suppresses every rule.

```ts
// refcheck-ignore missing-export, bad-call-arity -- patched at build time
import { postJson } from "tiny-http";
```

## Benchmark

`bench/` holds 43 labelled snippets checked against 5 fake packages (`bench/project/node_modules`): 16 correct snippets, 23 with one realistic hallucination (invented named exports, wrong option keys, nonexistent subpaths, wrong arity, typo'd package names, deprecated calls, a missing relative file), and 4 `miss-*` snippets that are hallucinations `refcheck` is known not to catch. Each file starts with `// expect: <rule>` or `// expect: none`. `npm run bench` builds the project and prints this (measured on this repository, Node 22, Apple silicon):

```
rule                     cases  TP  FP  FN  precision  recall
unknown-package              3   3   0   0       100%    100%
not-installed                1   1   0   0       100%    100%
unresolved-subpath           4   4   0   0       100%    100%
missing-export               7   4   0   3       100%     57%
bad-call-arity               3   3   0   0       100%    100%
unknown-option-key           5   4   0   1       100%     80%
deprecated-api               3   3   0   0       100%    100%
relative-import-missing      1   1   0   0       100%    100%

snippets: 43 (16 correct, 27 with a hallucinated reference)
snippets classified exactly right: 39/43
analysis time: 227 ms for 43 files in one program
```

Be careful with these numbers. The packages and the snippets were written by the same person who wrote the rules, so near-perfect scores on the rules they were designed for are expected and say little about how often `refcheck` is right on code you did not anticipate. What the benchmark does show: the rules fire on the shapes they target, none of the 16 correct snippets (including overloads, `export =`, pattern subpaths, spread arguments and a suppression comment) produces a finding, and the 4 `miss-*` snippets are real gaps (listed below). It is a regression suite, not an accuracy study. The 227 ms figure is one run on one machine. The same snippets run as tests (`test/bench-cases.test.ts`).

## Limitations

- **JavaScript-only packages are not inspected for exports or call shapes.** If a package ships no `.d.ts` (and has no `@types/*`), `refcheck` still checks the package name and subpath, but not named imports or calls. (`miss-03`)
- **`require()` is checked for package and subpath only**, not for destructured names. (`miss-04`)
- **Only object literals written inline in the call are checked for option keys.** Options built in a variable are not. (`miss-01`) This matches TypeScript's own excess-property behavior.
- **Invented members on instances** (`client.getAll()` where `getAll` does not exist) are not reported by a `refcheck` rule; the TypeScript compiler reports them if you run it. (`miss-02`)
- No argument type checking; arity and key names only.
- Default imports are only flagged when the module is known to be an ES module (`.mts`, `"type": "module"`, or your own `.ts` files), because CommonJS declarations can legitimately be default-imported through interop.
- Analysis uses its own TypeScript with Bundler-style resolution plus `paths`, `baseUrl`, `jsx` and `lib` from your root `tsconfig.json`. Unusual resolution setups (custom conditions, `typesVersions` trickery) can differ from your build. `typesVersions` packages skip the file-layout subpath check.
- `exports` conditions other than `import` and `require` are treated as matchable, so a package that only offers a condition for a runtime you do not use is not flagged.
- Pnpm and workspace layouts are supported through the `node_modules` lookup and `workspaces` globs (`dir/*` and exact paths only); nothing beyond that was tested against real monorepos.
- A finding is a statement about installed code. It does not prove the code is wrong at runtime, and a clean run does not prove it is right.

## Development

```
npm install
npm run typecheck
npm test
npm run build
npm run bench
```

The tests build fake `node_modules` trees in temp directories (`package.json` with `exports` plus `.d.ts` files); none installs real packages or touches the network. Every test file runs with a private `HOME`, a private empty global git config, `GIT_CONFIG_NOSYSTEM=1` and a `GIT_CEILING_DIRECTORIES` at the temp root, so the hook tests cannot reach your real git configuration or hooks. A smoke test spawns the built CLI against a temp project.

## License

MIT
