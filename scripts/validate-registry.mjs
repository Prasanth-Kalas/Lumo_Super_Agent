#!/usr/bin/env node

import Ajv from "ajv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const schemaPath = resolve(root, "config/agents.registry.schema.json");
const registryPaths = [
  "config/agents.registry.json",
  "config/agents.registry.prod.json",
  "config/agents.registry.vercel.json",
];

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
let failed = false;

for (const rel of registryPaths) {
  const abs = resolve(root, rel);
  const config = JSON.parse(await readFile(abs, "utf8"));
  if (validate(config)) {
    console.log(`✓ ${rel}`);
    continue;
  }
  failed = true;
  console.error(`✗ ${rel}`);
  for (const err of validate.errors ?? []) {
    const path = err.instancePath || "<root>";
    if (err.keyword === "additionalProperties") {
      console.error(`  - ${path}: unknown key "${err.params.additionalProperty}"`);
    } else {
      console.error(`  - ${path}: ${err.message ?? err.keyword}`);
    }
  }
}

process.exit(failed ? 1 : 0);
