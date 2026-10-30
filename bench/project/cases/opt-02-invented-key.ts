// expect: unknown-option-key
import { slugify } from "@acme/utils";

export const s = slugify("a b", { fancy: true });
