import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(['node_modules','.git','data'].includes(e.name))continue;walk(p);}else if(/\.(js|mjs)$/.test(e.name)){const src=fs.readFileSync(p,'utf8');try{acorn.parse(src,{ecmaVersion:'latest',sourceType:'module'});}catch(err){console.log('FAIL',p,err.message);process.exitCode=1;}}}}
walk(process.argv[2]||'.');
console.log('checked');
