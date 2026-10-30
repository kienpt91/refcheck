// expect: none
import * as http from "tiny-http";

export const res = http.get("/a", { json: true });
