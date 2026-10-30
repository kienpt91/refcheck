// expect: unresolved-subpath
import { chunk } from "@acme/utils/array";

export const c = chunk([1, 2, 3], 2);
