// A fast static site generator: the entry's driver. The harness runs
// `node /bot/main.ts` (node22). It reads every case from /input/cases.json
// (a JSON array of {id, input}), answers each one alone with run() from
// solve.js, and writes /output/answers.json: a JSON array of the answers,
// one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
// --no-opt: this workload is a single cold run per process, so TurboFan's
// optimizing compiler only costs CPU (measured: cold run() 409 ms with it,
// 262 ms without it) and never pays back within one run.
setFlagsFromString('--no-incremental-marking --no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
// Stream the answers out one case at a time: JSON.stringify([a,b,c]) is
// byte-identical to '[' + JSON.stringify(a) + ',' + JSON.stringify(b) + ','
// + JSON.stringify(c) + ']', but this avoids holding all answers (7.4 MB of
// strings plus their object graph) and one giant 7.4 MB string in memory
// while serializing — the per-answer string is freed right after writing.
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let k = 0; k < cases.length; k++) {
  if (k > 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[k].input)));
}
writeSync(fd, ']');
closeSync(fd);
