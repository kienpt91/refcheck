// expect: unknown-option-key
import { createClient } from "tiny-http";

export const c = createClient("https://example.test", { timeOut: 5000 });
