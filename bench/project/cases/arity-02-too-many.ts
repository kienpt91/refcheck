// expect: bad-call-arity
import { get } from "tiny-http";

export const r = get("/a", { json: true }, "extra");
