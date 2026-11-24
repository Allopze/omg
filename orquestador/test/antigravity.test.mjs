// Integración del ejecutor Antigravity (agy) con un agy falso que imita al binario real (1.5.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAC, entorno, orq, eventos, delegaciones, llamadasAgy, git, ajustesRepo, permitirCuentaPersonal, bloquearCuentaPersonal,
} from './ayuda.mjs';

const NEON = 'antigravity/gemini-4-neon';
const HYDROGEN = 'antigravity/gemini-4-hydrogen';

test('Antigravity: delegación de escritura, continuación y rol de solo lectura con agy', () => {
  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  const r = orq(ctx, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'Agrega docs.' });
  assert.equal(r.codigo, 0, r.error + r.salida);

  const [llamada] = llamadasAgy(ctx);
  assert.deepEqual(llamada.args, [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-4-neon-high', '--dangerously-skip-permissions',
  ]);
  assert.match(llamada.cwd, /\.claude\/worktrees\//);
  const mensaje = JSON.parse(llamada.entrada);
  assert.equal(mensaje.event, 'user');
  assert.match(mensaje.message.content, /rol: implementar · intento 1\/2[\s\S]*Agrega docs\./);

  const [ev] = delegaciones(ctx);
  assert.equal(ev.ejecutor, 'antigravity');
  assert.equal(ev.slug, 'gemini-4-neon-high');
  assert.equal(ev.archivos.length, 1);
  assert.deepEqual(ev.uso, { entrada: 25000, salida: 400, razonamiento: 50, cache: 20000, total: 25450, costo: null });
  assert.deepEqual(ev.herramientas, { write_file: 1 });
  if (MAC) assert.equal(ev.sandbox, 'sandbox-exec');
  assert.match(r.salida, /--- respuesta de Antigravity ---\nArchivos modificados/);
  assert.doesNotMatch(r.salida, /"event":/);
  assert.match(r.salida, /modelo: antigravity\/gemini-4-neon \(gemini-4-neon-high\) · effort: high · Antigravity/);
  assert.match(r.salida, /tokens: entrada 25000 · salida 400 · razonamiento 50 · caché 20000/);

  // reintento con el mismo modelo: effort_reintento (max) → slug xhigh, mismo worktree
  orq(ctx, ['revision', ev.id, 'corregido']);
  const r2 = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea, '--modelo', NEON], { entrada: 'Corrige.' });
  assert.equal(r2.codigo, 0, r2.error);
  const ev2 = delegaciones(ctx)[1];
  assert.equal(ev2.intento, 2);
  assert.equal(ev2.slug, 'gemini-4-neon-xhigh');
  assert.equal(ev2.worktree, ev.worktree);
  assert.equal(ev2.archivos_acumulados.length, 2);

  // solo lectura: --mode plan (sin él, agy escribe); dentro del sandbox, además se aprueban los permisos
  // (agy 1.5.14 deja la respuesta vacía si en plan necesita un comando), porque el SO impide escribir.
  const lectura = orq(ctx, ['delegar', 'analizar', '--modelo', HYDROGEN], { entrada: 'Resume.' });
  assert.equal(lectura.codigo, 0, lectura.error);
  const ll = llamadasAgy(ctx).at(-1);
  const esperado = ['--model', 'gemini-4-hydrogen-medium', '--mode', 'plan', ...(MAC ? ['--dangerously-skip-permissions'] : [])];
  assert.deepEqual(ll.args.slice(-esperado.length), esperado);
  assert.equal(fs.realpathSync(ll.cwd), ctx.repo);
  assert.match(lectura.salida, /Análisis listo/);

  const s = JSON.parse(orq(ctx, ['scorecard', '--json']).salida);
  assert.equal(s.totales.tokens, 25450 * 3);
  const filasNeon = s.filas.filter((f) => f.modelo === NEON);
  assert.ok(filasNeon.every((f) => f.ejecutor === 'antigravity'));
  assert.equal(filasNeon.reduce((n, f) => n + f.delegaciones, 0), 2, 'una fila por effort (high y max)');
});

test('Antigravity: con permitir_cuenta_personal: false, orq bloquea la cuenta personal; API key y ADC no se bloquean', () => {
  const ctx = entorno({ editarRegistro: bloquearCuentaPersonal });
  const r = orq(ctx, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x' });
  assert.equal(r.codigo, 3);
  assert.match(r.error, /cuenta personal.*permitir_cuenta_personal/s);
  assert.ok(!fs.existsSync(ctx.llamadasAgy), 'no llegó a ejecutar agy');
  assert.ok(!git(ctx, 'branch').includes('delegar/'), 'no creó worktree');
  assert.match(orq(ctx, ['estado']).salida, /Antigravity: tu cuenta personal de Google — BLOQUEADO/);
  // el modelo primario del rol (Command Code) no se ve afectado
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'x' }).codigo, 0);

  const conKey = entorno({ editarRegistro: bloquearCuentaPersonal, agySettings: { modelProvider: 'gemini' } });
  assert.equal(orq(conKey, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x' }).codigo, 0);
  assert.match(orq(conKey, ['estado']).salida, /Antigravity: API key de Gemini \(AI Studio\)/);

  const conAdc = entorno({ editarRegistro: bloquearCuentaPersonal });
  assert.equal(orq(conAdc, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x', env: { AGY_ADC_AUTH: 'true' } }).codigo, 0);
});

test('Antigravity: la plantilla del registro permite la cuenta personal por defecto', () => {
  const ctx = entorno();
  assert.equal(orq(ctx, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x' }).codigo, 0);
  assert.doesNotMatch(orq(ctx, ['estado']).salida, /BLOQUEADO/);
});

test('Antigravity: un resultado con estado ERROR se reporta como falla', () => {
  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  const r = orq(ctx, ['delegar', 'tests', '--modelo', HYDROGEN], { entrada: 'x', modoAgy: 'error' });
  assert.equal(r.codigo, 1);
  const [ev] = delegaciones(ctx);
  assert.match(ev.alertas.join(' '), /Antigravity reportó un error: estado ERROR: cuota agotada/);
  assert.equal(ev.exit_code, 1);
});

test('Antigravity: una respuesta vacía (permiso denegado en headless) cuenta como falla', () => {
  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  const r = orq(ctx, ['delegar', 'analizar', '--modelo', HYDROGEN], { entrada: 'x', modoAgy: 'sin-respuesta' });
  assert.equal(r.codigo, 1);
  const [ev] = delegaciones(ctx);
  assert.match(ev.alertas.join(' '), /Antigravity terminó sin respuesta: jetski: no output produced .*auto-denied/);
  // sin sandbox, el rol de solo lectura queda en modo plan sin aprobar permisos
  const sin = entorno({ editarRegistro: permitirCuentaPersonal, sandbox: 'desactivado' });
  orq(sin, ['delegar', 'analizar', '--modelo', HYDROGEN], { entrada: 'x' });
  assert.deepEqual(llamadasAgy(sin)[0].args.slice(-2), ['--mode', 'plan']);
});

test('Antigravity: si agy cambia su settings.json, se detecta; dentro del sandbox ni siquiera puede', () => {
  const sinSandbox = entorno({ editarRegistro: permitirCuentaPersonal, sandbox: 'desactivado' });
  const r = orq(sinSandbox, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x', modoAgy: 'toca-settings' });
  assert.equal(r.codigo, 5, r.error + r.salida);
  assert.match(delegaciones(sinSandbox)[0].criticas.join(' '), /agy-settings\.json/);

  if (!MAC) return;
  const conSandbox = entorno({ editarRegistro: permitirCuentaPersonal });
  const antes = fs.readFileSync(conSandbox.agySettings, 'utf8');
  const r2 = orq(conSandbox, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x', modoAgy: 'toca-settings' });
  assert.equal(r2.codigo, 0, r2.error + r2.salida);
  assert.equal(fs.readFileSync(conSandbox.agySettings, 'utf8'), antes);
  const objetivo = path.join(conSandbox.repo, 'escape.txt');
  orq(conSandbox, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x', modoAgy: 'escapa', env: { CMD_FALSO_OBJETIVO: objetivo } });
  assert.ok(!fs.existsSync(objetivo));
});

test('Antigravity: skills declaradas no se pasan y el resumen lo avisa', () => {
  const ctx = entorno({
    editarRegistro: (y) => permitirCuentaPersonal(y).replace('skills_compatibles: null', 'skills_compatibles: true'),
  });
  fs.mkdirSync(path.join(ctx.repo, '.claude', 'skills', 'estilo'), { recursive: true });
  ajustesRepo(ctx, 'roles:\n  implementar:\n    skills: [.claude/skills/estilo]\n');
  const r = orq(ctx, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error);
  assert.ok(!llamadasAgy(ctx)[0].args.includes('--skill'));
  assert.match(r.salida, /Antigravity no recibe skills por flag; resume sus reglas dentro del prompt/);
});

test('Antigravity: escala igual que Command Code al agotar los intentos', () => {
  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  orq(ctx, ['delegar', 'implementar', '--modelo', NEON], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea, '--modelo', NEON], { entrada: 'y' });
  const r = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'z' });
  assert.equal(r.codigo, 4);
  assert.match(r.salida, /implementador-sonnet/);
  assert.equal(eventos(ctx).filter((e) => e.tipo === 'escalamiento').length, 1);
});

test('Antigravity: verificar y doctor', () => {
  const bloqueado = entorno({ editarRegistro: bloquearCuentaPersonal });
  const vb = orq(bloqueado, ['verificar', '--sin-llamadas', '--modelo', NEON]);
  assert.equal(vb.codigo, 1);
  assert.match(vb.salida, /✘ Antigravity: autenticación con tu cuenta personal de Google — el registro no lo permite/);
  assert.match(orq(bloqueado, ['doctor']).salida, /! Antigravity usa tu cuenta personal de Google y el registro no lo permite/);

  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  const v = orq(ctx, ['verificar', '--modelo', NEON]);
  assert.equal(v.codigo, 0, v.salida + v.error);
  assert.match(v.salida, /✔ Versión de Antigravity >= 1\.5\.4/);
  for (const slug of ['gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh']) {
    assert.match(v.salida, new RegExp(`✔ "${slug}" aparece en el catálogo de Antigravity`));
    assert.match(v.salida, new RegExp(`✔ antigravity/gemini-4-neon: slug ${slug}`));
  }
  assert.match(v.salida, /✔ antigravity\/gemini-4-neon: como rol de solo lectura no escribe archivos/);
  if (MAC) assert.match(v.salida, /✔ antigravity\/gemini-4-neon: el sandbox bloquea sus escrituras fuera del worktree/);
  assert.doesNotMatch(v.salida, /Command Code/, '--modelo limita la verificación a ese modelo');
  assert.match(orq(ctx, ['doctor']).salida, /✔ Antigravity: tu cuenta personal de Google \(permitida en el registro\)/);
});
