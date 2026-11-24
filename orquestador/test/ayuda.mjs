// Entorno aislado para los tests de integración: repo, datos, config de Claude, HOME y TMPDIR propios,
// con Command Code y Antigravity falsos. Nada toca tu ~/.gemini, ~/.commandcode ni ~/.claude reales.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORQ = path.join(DIR, 'bin', 'orq.mjs');
export const CMD_FALSO = path.join(DIR, 'test', 'fixtures', 'cmd-falso.mjs');
export const AGY_FALSO = path.join(DIR, 'test', 'fixtures', 'agy-falso.mjs');
export const SKILL = path.join(DIR, '..', 'skill', 'orquestar', 'SKILL.md');
export const MAC = process.platform === 'darwin';

const TEMPORALES = new Set();
let limpiezaRegistrada = false;

function limpiarTemporales() {
  for (const ruta of TEMPORALES) {
    try {
      fs.rmSync(ruta, { recursive: true, force: true });
    } catch { /* ignorar */ }
  }
  TEMPORALES.clear();
}

export function registrarTemporal(ruta) {
  TEMPORALES.add(ruta);
  if (!limpiezaRegistrada) {
    limpiezaRegistrada = true;
    process.on('exit', limpiarTemporales);
  }
  return ruta;
}

/**
 * orq corre con TMPDIR y HOME propios: así el sandbox solo deja escribir en el worktree y en ese
 * temporal, y se puede comprobar que bloquea el resto.
 */
export function entorno({ editarRegistro = (y) => y, sandbox, agySettings = {}, base = os.tmpdir() } = {}) {
  fs.mkdirSync(base, { recursive: true });
  const dir = registrarTemporal(fs.realpathSync(fs.mkdtempSync(path.join(base, 'orq-int-'))));
  const repo = path.join(dir, 'repo');
  const datos = path.join(dir, 'datos');
  const claude = path.join(dir, 'claude');
  const tmp = path.join(dir, 'tmp');
  const home = path.join(dir, 'home');
  for (const d of [repo, datos, tmp, home]) fs.mkdirSync(d);
  fs.mkdirSync(path.join(claude, 'skills', 'orquestar'), { recursive: true });
  fs.copyFileSync(SKILL, path.join(claude, 'skills', 'orquestar', 'SKILL.md'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'inicio');
  let yaml = editarRegistro(fs.readFileSync(path.join(DIR, 'models.yaml'), 'utf8'), dir);
  if (sandbox) yaml = yaml.replace('modo: auto', `modo: ${sandbox}`);
  fs.writeFileSync(path.join(datos, 'models.yaml'), yaml);
  const rutaAgySettings = path.join(tmp, 'agy-settings.json');
  fs.writeFileSync(rutaAgySettings, JSON.stringify({ trustedWorkspaces: [], ...agySettings }));
  // Los falsos anotan sus llamadas en /tmp: es lo único escribible fuera del worktree y del temporal propio
  // de cada ejecución (el TMPDIR de orq ya no lo es).
  const registros = registrarTemporal(fs.mkdtempSync(path.join('/tmp', 'orq-test-llamadas-')));
  return {
    dir, repo, datos, claude, tmp, home,
    llamadas: path.join(registros, 'llamadas.jsonl'),
    llamadasAgy: path.join(registros, 'agy-llamadas.jsonl'),
    agySettings: rutaAgySettings,
    registro: path.join(datos, 'models.yaml'),
  };
}

/** Permite a orq usar agy con la cuenta personal (para los tests de Antigravity). */
export const permitirCuentaPersonal = (y) => y.replace(/permitir_cuenta_personal: (true|false)/, 'permitir_cuenta_personal: true');
/** Bloquea agy con la cuenta personal (por defecto viene permitido). */
export const bloquearCuentaPersonal = (y) => y.replace(/permitir_cuenta_personal: (true|false)/, 'permitir_cuenta_personal: false');

/** Entorno con el que corre orq en los tests (aislado y con los ejecutores falsos). */
export function entornoOrq(ctx, { modo, modoAgy, env = {} } = {}) {
  const base = { ...process.env };
  delete base.AGY_ADC_AUTH;
  return {
    ...base,
    HOME: ctx.home,
    TMPDIR: ctx.tmp,
    ORQ_HOME: ctx.datos,
    CLAUDE_CONFIG_DIR: ctx.claude,
    ORQ_CMD_BIN: CMD_FALSO,
    ORQ_AGY_BIN: AGY_FALSO,
    ORQ_AGY_SETTINGS: ctx.agySettings,
    CMD_FALSO_REGISTRO: ctx.llamadas,
    AGY_FALSO_REGISTRO: ctx.llamadasAgy,
    ...(modo ? { CMD_FALSO_MODO: modo } : {}),
    ...(modoAgy ? { AGY_FALSO_MODO: modoAgy } : {}),
    ...env,
  };
}

export function orq(ctx, args, { entrada = '', modo, modoAgy, cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [ORQ, ...args], {
    cwd: cwd ?? ctx.repo,
    input: entrada,
    encoding: 'utf8',
    env: entornoOrq(ctx, { modo, modoAgy, env }),
  });
  return { codigo: r.status, salida: r.stdout, error: r.stderr };
}

const jsonl = (ruta) => fs.readFileSync(ruta, 'utf8').trim().split('\n').map(JSON.parse);
export const eventos = (ctx) => jsonl(path.join(ctx.datos, 'logs', 'delegaciones.jsonl'));
export const delegaciones = (ctx) => eventos(ctx).filter((e) => e.tipo === 'delegacion');
export const llamadas = (ctx) => jsonl(ctx.llamadas);
export const llamadasAgy = (ctx) => jsonl(ctx.llamadasAgy);
export const git = (ctx, ...a) => execFileSync('git', a, { cwd: ctx.repo, encoding: 'utf8' });
export const procesoVivo = (patron) => spawnSync('pgrep', ['-f', patron]).status === 0;
export function ajustesRepo(ctx, texto) {
  fs.mkdirSync(path.join(ctx.repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ctx.repo, '.claude', 'orquestador.yaml'), texto);
}
