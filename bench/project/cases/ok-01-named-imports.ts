// expect: none
import { createClient, get, post } from "tiny-http";

const client = createClient("https://example.test", { timeout: 2000, retries: 2 });
export const calls = [client, get("/status"), post("/items", { name: "a" })];
