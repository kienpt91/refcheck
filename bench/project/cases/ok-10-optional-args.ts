// expect: none
import { slugify, truncate, formatDate } from "@acme/utils";

export const out = [slugify("a"), truncate("abc", 2), formatDate(new Date())];
