// expect: none
import { createClient } from "tiny-http";

export const c = createClient("https://example.test", { keepAlive: true, auth: { user: "u", pass: "p" } });
