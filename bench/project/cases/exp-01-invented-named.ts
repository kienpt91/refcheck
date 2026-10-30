// expect: missing-export
import { postJson } from "tiny-http";

export const r = postJson("/a", {});
