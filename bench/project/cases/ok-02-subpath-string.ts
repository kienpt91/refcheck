// expect: none
import { slugify, truncate } from "@acme/utils/string";

export const title = truncate(slugify("Hello World", { lower: true }), 20, "...");
