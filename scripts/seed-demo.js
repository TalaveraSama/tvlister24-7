// Genera datos de demostración (biblioteca, listas, parrilla, publicidad).
import fs from 'node:fs';
import path from 'node:path';
import { demoData } from '../server/defaults.js';

const file = process.env.PROCA_DATA || path.resolve('data', 'proca.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(demoData(), null, 2));
console.log(`Datos de demostración escritos en ${file}`);
