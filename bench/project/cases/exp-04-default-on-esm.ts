// expect: missing-export
import http from "tiny-http";

export const r = http.get("/a");
