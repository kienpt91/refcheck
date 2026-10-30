// expect: unknown-option-key
import { createClient } from "tiny-http";

const options = { timeOut: 5000 };
export const c = createClient("https://example.test", options);
