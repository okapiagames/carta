#!/usr/bin/env node
/**
 * build.js — inlines game.html into worker.js
 * Run: node build.js
 * Output: dist/worker.js (deploy this)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const workerSrc = readFileSync(join(__dirname, 'src/worker.js'), 'utf8');
const gameSrc   = readFileSync(join(__dirname, 'src/game.html'), 'utf8');

// Escape backticks and ${} in the HTML so it's safe in a template literal
const escaped = gameSrc.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const output = workerSrc.replace('`__GAME_HTML__`', `\`${escaped}\``);

mkdirSync(join(__dirname, 'dist'), { recursive: true });
writeFileSync(join(__dirname, 'dist/worker.js'), output);
console.log('✅ Built → dist/worker.js');
