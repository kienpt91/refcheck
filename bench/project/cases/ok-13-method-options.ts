// expect: none
import { createClient } from "tiny-http";

const client = createClient("https://example.test");
export const r = client.get("/a", { headers: { accept: "text/plain" }, timeout: 10 });
