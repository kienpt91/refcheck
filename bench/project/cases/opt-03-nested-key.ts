// expect: unknown-option-key
import { createClient } from "tiny-http";

export const c = createClient("https://example.test", { auth: { username: "u", pass: "p" } });
