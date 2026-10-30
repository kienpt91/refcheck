// expect: none
import { readFileSync } from "node:fs";
import path from "path";
import { readFile } from "fs/promises";

export const files = [readFileSync, path.join, readFile];
