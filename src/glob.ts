/**
 * Minimal glob support for config ignore paths: `*`, `**`, `?`.
 * A pattern without a slash matches the basename at any depth; a trailing
 * slash matches everything below that directory.
 */
export const MAX_GLOB_LENGTH = 256;

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.endsWith("/")) p += "**";
  if (!p.includes("/")) p = "**/" + p;
  // Collapse runs of stars and repeated `**/` so patterns cannot backtrack polynomially.
  p = p.replace(/\*{2,}/g, "**").replace(/(?:\*\*\/){2,}/g, "**/");
  p = p.replace(/\*\*\*/g, "**");
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

export function matchesAny(relativePosixPath: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(relativePosixPath));
}
