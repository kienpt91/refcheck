// expect: deprecated-api
import { get } from "tiny-http";

export const r = get("/a", { maxWait: 100 });
