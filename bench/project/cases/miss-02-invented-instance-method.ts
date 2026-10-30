// expect: missing-export
import { createClient } from "tiny-http";

const client = createClient("https://example.test");
export const r = client.getAll("/a");
