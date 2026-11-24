#!/usr/bin/env node
// Imita a Command Code para los tests. Comportamiento según CMD_FALSO_MODO:
//   escribe (defecto)  crea docs/cambio-<n>.md
//   falla              termina con código 1
//   escribe-fuera      además crea src/fuera.js (fuera de docs/)
//   escribe-sin-yolo   escribe aunque no tenga --yolo
//   cuelga             lanza un hijo que hereda el stdout y nunca termina
//   deja-proceso       escribe, lanza un hijo que hereda el stdout y sale enseguida
//   escapa             intenta escribir en CMD_FALSO_OBJETIVO (ruta absoluta fuera del worktree)
//   lee-fuera          intenta leer CMD_FALSO_OBJETIVO y anota el resultado en docs/lectura.txt
//   toca-git           intenta modificar el archivo .git del worktree
//   toca-config        agrega una línea a CMD_FALSO_OBJETIVO (la configuración de git del repo)
//   cambia-rama        escribe y cambia de rama con git checkout -b
//   commitea           escribe y hace git commit por su cuenta
//   solo-escribir      solo escribe CMD_FALSO_ESCRIBIR, con o sin --yolo
//   repo-anidado       crea un repo git con un commit dentro del worktree
//   entorno            anota en docs/entorno.json algunas variables de entorno que recibió
//   sale-con           escribe y termina con el código CMD_FALSO_CODIGO (5 por defecto)
// CMD_FALSO_ESCRIBIR="a/b.txt,c.txt" crea además esas rutas relativas.
// Con --output-format json emite NDJSON con eventos y una línea final con usage.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('command-code 1.84.0'); process.exit(0); }
if (args.includes('--list-models')) { console.log('deepseek/deepseek-v4.1-flash-fast  DeepSeek V4.1 Flash Fast'); process.exit(0); }

const entrada = fs.readFileSync(0, 'utf8');
if (process.env.CMD_FALSO_REGISTRO) {
  fs.appendFileSync(process.env.CMD_FALSO_REGISTRO, `${JSON.stringify({ args, cwd: process.cwd(), entrada })}\n`);
}
const modo = process.env.CMD_FALSO_MODO || 'escribe';
const yolo = args.includes('--yolo');
const json = args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json';
const intentar = (fn) => { try { fn(); return true; } catch { return false; } };
const evento = (toolName) => json && console.log(JSON.stringify({ type: 'event', event: { type: 'tool_running', toolCallId: 'x', toolName } }));
const terminar = (texto) => {
  if (json) {
    console.log(JSON.stringify({
      type: 'result', subtype: 'success', sessionId: 's', stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 300 }, durationMs: 10, finalText: texto,
    }));
  } else console.log(texto);
  process.exit(0);
};

const escribirPedidos = () => {
  for (const r of (process.env.CMD_FALSO_ESCRIBIR ?? '').split(',').filter(Boolean)) {
    fs.mkdirSync(path.dirname(r), { recursive: true });
    fs.writeFileSync(r, `x ${Date.now()}\n`);
  }
};

if (modo === 'falla') { console.error('error simulado'); process.exit(1); }
if (modo === 'solo-escribir') { escribirPedidos(); terminar('OK'); }
if (modo === 'cuelga') {
  spawn('sleep', ['37.123'], { stdio: 'inherit' });
  setInterval(() => {}, 1000);
} else {
  // Prueba de lectura de verificar.mjs
  if (entrada.includes('secreto.txt') && fs.existsSync('secreto.txt')) {
    console.log(fs.readFileSync('secreto.txt', 'utf8').trim());
    if (yolo) fs.writeFileSync('nuevo.txt', 'hola');
    process.exit(0);
  }
  // Prueba de skills de verificar.mjs
  const iSkill = args.indexOf('--skill');
  if (iSkill !== -1 && entrada.includes('palabra clave')) {
    const texto = fs.readFileSync(path.join(args[iSkill + 1], 'SKILL.md'), 'utf8');
    terminar(texto.match(/CLAVE-[0-9a-f]+/)[0]);
  }
  // Prueba de sandbox de verificar.mjs
  if (entrada.includes('dentro.txt')) {
    intentar(() => fs.writeFileSync('dentro.txt', 'hola'));
    const fuera = entrada.match(/archivo (\/\S+\/fuera\.txt)/)?.[1];
    if (fuera) intentar(() => fs.writeFileSync(fuera, 'hola'));
    terminar('OK');
  }

  if (yolo || modo === 'escribe-sin-yolo') {
    evento('write_file');
    if (modo === 'escribe-fuera') {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/fuera.js', 'export const x = 1;\n');
    }
    if (modo === 'escapa') intentar(() => fs.writeFileSync(process.env.CMD_FALSO_OBJETIVO, 'escapé\n'));
    if (modo === 'repo-anidado') {
      // un repo dentro del worktree con un commit: git add lo agregaría como submódulo
      fs.mkdirSync('sub', { recursive: true });
      fs.writeFileSync(path.join('sub', 'a.txt'), 'x\n');
      execFileSync('git', ['init', '-q'], { cwd: 'sub' });
      execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'add', '-A'], { cwd: 'sub' });
      execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'x'], { cwd: 'sub' });
    }
    if (modo === 'bloquea-indice') {
      // deja un index.lock en el gitdir del worktree: el git add de orq falla después
      const gitdir = fs.readFileSync('.git', 'utf8').match(/^gitdir: (.+)$/m)[1].trim();
      fs.writeFileSync(path.join(gitdir, 'index.lock'), '');
    }
    if (modo === 'entorno') {
      fs.mkdirSync('docs', { recursive: true });
      const claves = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'AWS_REGION', 'MI_API_KEY', 'CMD_FALSO_MODO', 'TMPDIR', 'PATH', 'ORQ_SANDBOX'];
      fs.writeFileSync(path.join('docs', 'entorno.json'), JSON.stringify(Object.fromEntries(claves.map((k) => [k, process.env[k] ?? null]))));
    }
    if (modo === 'lee-fuera') {
      let leido = 'bloqueado';
      intentar(() => { leido = `leido:${fs.readFileSync(process.env.CMD_FALSO_OBJETIVO, 'utf8').trim()}`; });
      fs.mkdirSync('docs', { recursive: true });
      fs.writeFileSync(path.join('docs', 'lectura.txt'), `${leido}\n`);
    }
    if (modo === 'toca-git') intentar(() => fs.appendFileSync('.git', '\n'));
    if (modo === 'toca-config') intentar(() => fs.appendFileSync(process.env.CMD_FALSO_OBJETIVO, '[alias]\n\tx = status\n'));
    fs.mkdirSync('docs', { recursive: true });
    fs.writeFileSync(path.join('docs', `cambio-${Date.now()}-${process.pid}.md`), '# cambio\n');
    escribirPedidos();
    if (modo === 'cambia-rama') execFileSync('git', ['checkout', '-q', '-b', 'otra-rama'], { stdio: 'ignore' });
    if (modo === 'commitea') {
      execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'propio'], { stdio: 'ignore' });
    }
    if (modo === 'deja-proceso') spawn('sleep', ['38.321'], { stdio: 'inherit' }).unref();
    if (modo === 'sale-con') {
      // códigos propios de Command Code (3 auth, 4 permiso, 5 rate limit, 8 max turns)
      console.error('error simulado del ejecutor');
      process.exit(Number(process.env.CMD_FALSO_CODIGO ?? 5));
    }
    terminar('Archivos modificados: docs/cambio.md');
  } else {
    evento('read_file');
    terminar('OK');
  }
}
