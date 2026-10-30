// expect: none
// refcheck-ignore missing-export -- provided by a build-time patch
import { postJson } from "tiny-http";

export const p = postJson;
