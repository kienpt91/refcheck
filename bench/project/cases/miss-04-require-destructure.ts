// expect: missing-export
declare const require: (id: string) => any;
const { postJson } = require("tiny-http");

export const r = postJson;
