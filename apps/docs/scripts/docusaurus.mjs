#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);

const codegenRoutesPath = require.resolve(
  "@docusaurus/core/lib/server/codegen/codegenRoutes.js",
);
const codegenRoutesSource = fs.readFileSync(codegenRoutesPath, "utf8");
const genRegistryStart = codegenRoutesSource.indexOf("const genRegistry =");
const genRegistryEnd = codegenRoutesSource.indexOf("const genRoutesChunkNames =", genRegistryStart);

if (genRegistryStart === -1 || genRegistryEnd === -1) {
  throw new Error("Unable to patch Docusaurus registry codegen.");
}

// The monorepo runs on newer Node/Webpack than Docusaurus 3.5 expects.
// Static imports keep SSR route modules bundled instead of falling back to
// Node require() for @theme and MDX aliases during static generation.
const staticRegistryCodegen = [
  "const genRegistry = ({ generatedFilesDir, registry, }) => {",
  "    const entries = Object.entries(registry).sort((a, b) => a[0].localeCompare(b[0]));",
  "    const imports = entries",
  '        .map(([, modulePath], index) => `import * as routeModule_${index} from "${modulePath}";`)',
  "        .join('\\n');",
  "    const registryEntries = entries",
  "        .map(([chunkName, modulePath], index) =>",
  "// modulePath is already escaped by escapePath",
  '        `  "${chunkName}": [() => Promise.resolve(routeModule_${index}), "${modulePath}", undefined],`)',
  "        .join('\\n');",
  "    return (0, utils_1.generate)(generatedFilesDir, 'registry.js', `${imports}\\n\\nexport default {\\n${registryEntries}\\n};\\n`);",
  "};",
  "",
].join("\n");

const codegenRoutesPatched =
  codegenRoutesSource.slice(0, genRegistryStart) +
  staticRegistryCodegen +
  codegenRoutesSource.slice(genRegistryEnd);

if (codegenRoutesPatched !== codegenRoutesSource) {
  fs.writeFileSync(codegenRoutesPath, codegenRoutesPatched);
}

for (const extension of [".css", ".scss", ".sass"]) {
  if (!require.extensions?.[extension]) {
    require.extensions[extension] = () => undefined;
  }
}

await import("@docusaurus/core/bin/docusaurus.mjs");
