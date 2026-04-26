#!/usr/bin/env node
/**
 * Generates the canonical Lumo wordmark PNG into public/lumo-wordmark.png.
 *
 * Source of truth — the brand artwork in chat: bright cyan body
 * (#1FB8E8) with darker same-hue paper-fold creases (#0F7FAE).
 * Run this if the wordmark needs to be regenerated at higher
 * resolution or with tweaked geometry; commit the resulting PNG.
 *
 * Usage:  node scripts/build-wordmark.mjs
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "public", "lumo-wordmark.svg");

// Crisp polygon-fold SVG kept as the master asset; <img> references
// are sharper than inlined React SVG components in some browsers and
// avoid theme-token drift entirely.
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 24" width="500" height="120" role="img" aria-label="Lumo">
  <defs>
    <clipPath id="lwa-l"><path d="M0 1 H6 V18 H17 V23 H0 Z"/></clipPath>
    <clipPath id="lwa-u"><path d="M22 1 H28 V15.5 a4 4 0 0 0 8 0 V1 H42 V16 a10 10 0 0 1 -20 0 Z"/></clipPath>
    <clipPath id="lwa-m"><path d="M48 23 V1 H54 L60 11 L66 1 H72 V23 H66 V11 L62 17 H58 L54 11 V23 Z"/></clipPath>
    <clipPath id="lwa-o"><path d="M88 12 a10 10 0 1 1 -20 0 a10 10 0 0 1 20 0 Z M82 12 a4 4 0 1 0 -8 0 a4 4 0 0 0 8 0 Z"/></clipPath>
  </defs>
  <g clip-path="url(#lwa-l)"><rect x="0" y="0" width="22" height="24" fill="#1FB8E8"/></g>
  <g clip-path="url(#lwa-u)">
    <rect x="22" y="0" width="22" height="24" fill="#1FB8E8"/>
    <polygon points="24,1 31,1 42,23 35,23" fill="#0F7FAE"/>
  </g>
  <g clip-path="url(#lwa-m)">
    <rect x="48" y="0" width="24" height="24" fill="#1FB8E8"/>
    <polygon points="52,1 59,1 70,23 63,23" fill="#0F7FAE"/>
  </g>
  <g clip-path="url(#lwa-o)">
    <rect x="68" y="2" width="20" height="20" fill="#1FB8E8"/>
    <rect x="83" y="2" width="5" height="20" fill="#0F7FAE"/>
  </g>
</svg>
`;

writeFileSync(out, svg, "utf8");
console.log(`wrote ${out}`);
