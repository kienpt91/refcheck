// expect: missing-export
import * as http from "tiny-http";

export const all = http.requestAll(["/a", "/b"]);
