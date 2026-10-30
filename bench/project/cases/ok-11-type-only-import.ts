// expect: none
import type { RequestOptions, Response } from "tiny-http";

export function describe(o: RequestOptions, r: Response): string {
  return `${o.timeout ?? 0}:${r.status}`;
}
