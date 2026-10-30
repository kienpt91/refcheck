// expect: none
import createStore, { version } from "state-kit";

export const store = createStore({ count: 0 }, { name: "counter", persist: false });
export const v = version;
