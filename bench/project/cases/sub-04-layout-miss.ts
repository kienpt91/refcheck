// expect: unresolved-subpath
import { createReadStream } from "csv-lite/lib/nope";

export const s = createReadStream;
