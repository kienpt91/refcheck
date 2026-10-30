// expect: bad-call-arity
import { createClient } from "tiny-http";

const client = createClient("https://example.test");
export const r = client.get();
