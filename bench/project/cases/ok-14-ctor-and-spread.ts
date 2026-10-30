// expect: none
import { Emitter } from "state-kit";

const e = new Emitter();
const named = new Emitter("jobs");
const args: unknown[] = [1, 2];
e.emit("done", ...args);
named.on("x", () => undefined);
