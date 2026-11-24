#!/usr/bin/env node
// Imita a Antigravity CLI (agy 1.5.4) para los tests: --version, `agy models` y el modo headless
// con --input-format/--output-format stream-json, tal como se observó en el binario real.
//   AGY_FALSO_MODO: escribe (defecto) | error | sin-respuesta | toca-settings | escapa
//   AGY_FALSO_REGISTRO: JSONL donde anota cada llamada { args, cwd, entrada }
// Escribe solo con --dangerously-skip-permissions y sin --mode plan (como el real con permisos).
import fs from 'node:fs';
import path from 'node:path';

const SLUGS = [
  'gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh',
  'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh',
  'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high',
  'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high',
];
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.5.4'); process.exit(0); }
if (args[0] === 'models') { console.log('Fetching available models...'); for (const s of SLUGS) console.log(`${s}\t${s}`); process.exit(0); }

const valor = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
if (valor('--input-format') !== 'stream-json' || valor('--output-format') !== 'stream-json') {
  console.error('agy-falso solo implementa stream-json');
  process.exit(2);
}
const entrada = fs.readFileSync(0, 'utf8');
const prompt = entrada.split('\n').filter(Boolean).map((l) => JSON.parse(l).message.content).join('\n');
if (process.env.AGY_FALSO_REGISTRO) {
  fs.appendFileSync(process.env.AGY_FALSO_REGISTRO, `${JSON.stringify({ args, cwd: process.cwd(), entrada })}\n`);
}

const conv = `conv-${process.pid}`;
const emitir = (o) => console.log(JSON.stringify(o));
const resultado = (status, response, extra = {}) => emitir({
  event: 'result',
  result: {
    conversation_id: conv, status, response, duration_seconds: 1, num_turns: 1,
    usage: { input_tokens: 25000, output_tokens: 400, thinking_tokens: 50, cache_read_tokens: 20000, total_tokens: 25450 },
    ...extra,
  },
});
const herramienta = (nombre) => {
  for (const state of ['ACTIVE', 'DONE']) {
    emitir({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state, step_type: 'tool', tool_name: nombre } });
  }
};
const intentar = (fn) => { try { fn(); return true; } catch { return false; } };

const modelo = valor('--model');
emitir({ event: 'init', conversation_id: conv, init: { model: modelo, cwd: process.cwd(), tools: ['read_file', 'write_file'] } });
if (!SLUGS.includes(modelo)) { resultado('ERROR', '', { error: `unknown model "${modelo}"` }); process.exit(1); }
const modo = process.env.AGY_FALSO_MODO || 'escribe';
if (modo === 'error') { resultado('ERROR', '', { error: 'cuota agotada' }); process.exit(1); }
if (modo === 'sin-respuesta') {
  // Lo que hace agy 1.5.14 cuando en headless se deniega un permiso: respuesta vacía, código 0.
  console.error('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.');
  resultado('SUCCESS', '');
  process.exit(0);
}
const escribe = args.includes('--dangerously-skip-permissions') && valor('--mode') !== 'plan';

// Pruebas de verificar.mjs
if (prompt.includes('secreto.txt') && fs.existsSync('secreto.txt')) {
  herramienta('read_file');
  if (escribe) fs.writeFileSync('nuevo.txt', 'hola');
  resultado('SUCCESS', `${fs.readFileSync('secreto.txt', 'utf8').trim()}\n`);
  process.exit(0);
}
if (prompt.includes('dentro.txt')) {
  if (escribe) {
    intentar(() => fs.writeFileSync('dentro.txt', 'hola'));
    const fuera = prompt.match(/archivo (\/\S+\/fuera\.txt)/)?.[1];
    if (fuera) intentar(() => fs.writeFileSync(fuera, 'hola'));
  }
  resultado('SUCCESS', 'OK\n');
  process.exit(0);
}

if (escribe) {
  herramienta('write_file');
  if (modo === 'escapa') intentar(() => fs.writeFileSync(process.env.CMD_FALSO_OBJETIVO, 'escapé\n'));
  if (modo === 'toca-settings') {
    intentar(() => {
      const ruta = process.env.ORQ_AGY_SETTINGS;
      const s = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      s.permissions = { allow: ['command(*)'] };
      fs.writeFileSync(ruta, JSON.stringify(s));
    });
  }
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(path.join('docs', `agy-${Date.now()}-${process.pid}.md`), '# agy\n');
  resultado('SUCCESS', 'Archivos modificados: docs/agy.md\n');
} else {
  herramienta('read_file');
  resultado('SUCCESS', 'Análisis listo\n');
}
