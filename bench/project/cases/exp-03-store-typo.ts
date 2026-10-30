// expect: missing-export
import { createStores } from "state-kit";

export const s = createStores({});
