// expect: none
import parse from "csv-lite";
import { stringify } from "csv-lite";

export const rows = parse("a,b\n1,2", { delimiter: "," });
export const text = stringify(rows);
