// expect: unresolved-subpath
import { enabled } from "@acme/utils/features/zzz";

export const e = enabled;
