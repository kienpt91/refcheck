// expect: unknown-option-key
import { createClient } from "tiny-http";

const client = createClient("https://example.test");
export const r = client.post("/a", {}, { header: { a: "b" } });
