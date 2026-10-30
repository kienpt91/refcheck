// expect: none
import { enabled as a } from "@acme/utils/features/a";
import { enabled as b } from "@acme/utils/features/b";

export const both = a && b;
