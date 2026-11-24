// Unidades de la revisión final: registro como texto, --desde local, escalamientos de la 0.2,
// enlaces simbólicos, claves especiales del YAML, entorno sin secretos y reglas nuevas del sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { fijarClave, leerClave, hashRegistro, conservarFase0 } from '../lib/registro-texto.mjs';
import { desdeComoIso, calcularScorecard } from '../comandos/scorecard.mjs';
import { resumirTareas } from '../lib/tareas.mjs';
import { detectarSensible, registroEfectivo } from '../lib/config.mjs';
import { cargarRegistro, validarRegistro } from '../lib/registro.mjs';
import { entornoSinSecretos, perfilMacos, politicaSandbox } from '../lib/sandbox.mjs';

const MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.yaml');
const plantilla = fs.readFileSync(MODELS, 'utf8');

test('registro como texto: --guardar cambia solo dos líneas y el instalador lo reconoce como no modificado', () => {
  let t = fijarClave(plantilla, 'command_code', 'skills_compatibles', 'true');
  t = fijarClave(t, 'command_code', 'salida_json', 'false');
  const distintas = plantilla.split('\n').filter((l, i) => l !== t.split('\n')[i]);
  assert.equal(distintas.length, 2);
  assert.deepEqual(
    (({ skills_compatibles, salida_json }) => ({ skills_compatibles, salida_json }))(YAML.parse(t).command_code),
    { skills_compatibles: true, salida_json: false },
  );
  assert.equal(hashRegistro(t), hashRegistro(plantilla));
  assert.notEqual(hashRegistro(t.replace('timeout_min: 30', 'timeout_min: 31')), hashRegistro(plantilla));
  assert.equal(leerClave(t, 'command_code', 'salida_json'), 'false');
  // un registro sin salida_json (0.2): se agrega con la sangría de sus hermanas y no cambia la huella
  const viejo = 'command_code:\n  bin: cmd\n  skills_compatibles: null\nmodels: {}\n';
  const conClave = fijarClave(viejo, 'command_code', 'salida_json', 'true');
  assert.equal(conClave, 'command_code:\n  bin: cmd\n  skills_compatibles: null\n  salida_json: true\nmodels: {}\n');
  assert.equal(hashRegistro(conClave), hashRegistro(viejo));
  assert.match(conservarFase0(conClave, plantilla), /^ {2}salida_json: true$/m);
  assert.throws(() => fijarClave('models: {}\n', 'command_code', 'x', 'y'), /No encontré la sección/);
});

test('--desde es medianoche local, no UTC', () => {
  const iso = desdeComoIso('2026-11-01');
  assert.equal(new Date(iso).getHours(), 0);
  assert.equal(new Date(iso).getDate(), 1);
  assert.equal(desdeComoIso('2026-11-01T03:00:00.000Z'), '2026-11-01T03:00:00.000Z');
  assert.equal(desdeComoIso(undefined), null);
});

test('scorecard: una tarea que empezó antes de --desde no se parte en dos', () => {
  const reg = cargarRegistro(MODELS);
  const ev = (id, fecha, intento) => ({ tipo: 'delegacion', id, tarea: 't1', fecha, modelo: 'deepseek/deepseek-v4.1-flash-fast', rol: 'tests', effort: 'low', intento, raiz: '/r' });
  const eventos = [ev('t1', '2026-10-30T12:00:00.000Z', 1), ev('t2', '2026-11-05T12:00:00.000Z', 2), { tipo: 'revision', id: 't2', resultado: 'aprobado' }];
  assert.equal(calcularScorecard(eventos, reg, { desde: '2026-11-01' }).tareas.length, 0, 'la tarea empezó antes');
  const t = calcularScorecard(eventos, reg).tareas[0];
  assert.equal(t.resueltas_con_reintento, 1);
  assert.equal(t.intentos_por_tarea, 2);
});

test('escalamientos de la 0.2 (sin tarea) se asignan a su tarea y no se cuentan dos veces', () => {
  const eventos = [
    { tipo: 'delegacion', id: 'a', fecha: '2026-01-01T00:00:00Z', raiz: '/r', rol: 'tests' },
    { tipo: 'delegacion', id: 'b', fecha: '2026-01-02T00:00:00Z', raiz: '/otro', rol: 'tests' },
    { tipo: 'escalamiento', id: 'e', fecha: '2026-01-01T05:00:00Z', raiz: '/r', rol: 'tests' },
  ];
  const tareas = resumirTareas(eventos);
  assert.equal(tareas.find((t) => t.tarea === 'a').estado, 'escalada');
  assert.equal(tareas.find((t) => t.tarea === 'b').estado, 'abierta');
  const s = calcularScorecard(eventos, cargarRegistro(MODELS));
  assert.deepEqual([s.tareas[0].escaladas, s.tareas[0].abiertas], [1, 1]);
});

test('repos sensibles: el patrón coincide aunque la carpeta sea un enlace simbólico', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-enlace-')));
  fs.mkdirSync(path.join(dir, 'disco', 'privado-api'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'disco'), path.join(dir, 'dev'));
  const registro = { repos_sensibles: { rutas: [path.join(dir, 'dev', 'privado*')] } };
  assert.equal(detectarSensible(registro, path.join(dir, 'disco', 'privado-api'), null, []).sensible, true);
  assert.equal(detectarSensible(registro, path.join(dir, 'disco', 'otro'), null, []).sensible, false);
});

test('claves especiales en el YAML del repo no contaminan los roles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-proto-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.claude'));
  for (const texto of ['roles:\n  __proto__:\n    rutas_permitidas: [x/]\n', 'roles:\n  constructor:\n    effort: low\n', 'roles: [1, 2]\n']) {
    fs.writeFileSync(path.join(dir, '.claude', 'orquestador.yaml'), texto);
    assert.throws(() => registroEfectivo(dir, { rutaRegistro: MODELS, remotos: [] }), /orquestador\.yaml inválido/, texto);
  }
  assert.equal(Object.prototype.rutas_permitidas, undefined);
});

test('el registro rechaza claves desconocidas, escalamientos no nativos y listas con números', () => {
  const r = structuredClone(cargarRegistro(MODELS));
  r.repos_sensible = {};
  r.roles.tests.escala_a = ['antigravity/gemini-4-neon'];
  r.roles.documentar.rutas_permitidas = ['docs/', 2024];
  r.no_delegables = 'todo';
  assert.throws(() => validarRegistro(r), (e) => [/Claves desconocidas: repos_sensible/, /no es nativo/, /rutas_permitidas debe ser una lista de rutas/, /no_delegables/]
    .every((re) => re.test(e.message)));
});

test('entorno sin secretos: quita agentes y tokens, conserva lo que el ejecutor necesita', () => {
  const env = entornoSinSecretos([/^GEMINI_/], {
    PATH: '/bin', SSH_AUTH_SOCK: '/s', GH_TOKEN: 'x', AWS_REGION: 'us', NPM_TOKEN: 'x', npm_config__auth: 'x', GEMINI_API_KEY: 'k', LANG: 'es',
  });
  assert.deepEqual(Object.keys(env).sort(), ['GEMINI_API_KEY', 'LANG', 'PATH']);
});

test('perfil de macOS: temporales de Claude Code, agentes de SSH/GPG, Darwin temp y temporal propio', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-sb-'));
  const pol = politicaSandbox({}, { tmp, credencialesExtra: ['~/.npmrc'] });
  assert.ok(pol.escritura.includes(fs.realpathSync(tmp)));
  assert.ok(!pol.escritura.includes(fs.realpathSync(os.tmpdir())), 'el $TMPDIR compartido no entra en escritura (no reabre lectura_denegada)');
  assert.ok(pol.credenciales.some((p) => p.endsWith('/.npmrc')));
  const perfil = perfilMacos(pol);
  if (process.platform === 'darwin') {
    assert.ok(pol.darwinTmp && pol.temporalesSistema.includes(pol.darwinTmp), 'DARWIN_USER_TEMP_DIR queda habilitado para Foundation/Xcode');
    assert.match(perfil, /\(deny file-write\* \(regex #"\^.*\/orq-sb-\[\^\/\]\+\(\/\|\$\)"\)\)/);
  }
  assert.match(perfil, /\(deny file-read-data \(regex #"\^\/private\/tmp\/claude-\[0-9\]\+\(\/\|\$\)"\)\)/);
  assert.match(perfil, /\(deny file-write\* \(regex #"\^\/private\/tmp\/claude-/);
  assert.match(perfil, /\(deny network-outbound \(remote unix-socket \(path-regex #"\^\/private\/var\/run\/com\\\.apple\\\.launchd/);
  assert.match(perfil, /\(deny network-outbound \(remote unix-socket \(subpath ".*\/\.gnupg"\)\)\)/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
