// Unidades de la revisión final: registro como texto, --desde local, escalamientos de la 0.2,
// enlaces simbólicos, claves especiales del YAML, entorno sin secretos y reglas nuevas del sandbox.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  AJUSTES_USUARIO, fijarClave, leerClave, hashRegistro, conservarAjustes, conservarFase0,
} from '../lib/registro-texto.mjs';
import { desdeComoIso, calcularScorecard } from '../comandos/scorecard.mjs';
import { resumirTareas, buscarTarea, mapaRevisiones } from '../lib/tareas.mjs';
import { worktreesDelegacion, ramasDelegacionHuerfanas } from '../lib/worktrees.mjs';
import { detectarSensible, registroEfectivo } from '../lib/config.mjs';
import { cargarRegistro, validarRegistro, SALIDA } from '../lib/registro.mjs';
import { entornoSinSecretos, perfilMacos, politicaSandbox } from '../lib/sandbox.mjs';
import { leerJsonl } from '../lib/util.mjs';

const MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.yaml');
const plantilla = fs.readFileSync(MODELS, 'utf8');
const tempDirs = [];
const crearTemp = (prefijo) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  tempDirs.push(d);
  return d;
};

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

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
  const dir = fs.realpathSync(crearTemp('orq-enlace-'));
  fs.mkdirSync(path.join(dir, 'disco', 'privado-api'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'disco'), path.join(dir, 'dev'));
  const registro = { repos_sensibles: { rutas: [path.join(dir, 'dev', 'privado*')] } };
  assert.equal(detectarSensible(registro, path.join(dir, 'disco', 'privado-api'), null, []).sensible, true);
  assert.equal(detectarSensible(registro, path.join(dir, 'disco', 'otro'), null, []).sensible, false);
});

test('claves especiales en el YAML del repo no contaminan los roles', () => {
  const dir = crearTemp('orq-proto-');
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
  const tmp = crearTemp('orq-sb-');
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

test('registro-texto: AJUSTES_USUARIO, lectura_denegada: [], valores con # entre comillas y expansión de {}', () => {
  assert.ok(AJUSTES_USUARIO.some(([s, c]) => s === 'sandbox' && c === 'escritura_extra'));
  assert.ok(AJUSTES_USUARIO.some(([s, c]) => s === 'sandbox' && c === 'preparar_con_credenciales'));

  let anterior = fijarClave(plantilla, 'sandbox', 'lectura_denegada', '[]');
  anterior = fijarClave(anterior, 'sandbox', 'escritura_extra', '["~/C#"]');
  anterior = fijarClave(anterior, 'sandbox', 'preparar_con_credenciales', 'true');
  anterior = fijarClave(anterior, 'antigravity', 'permitir_cuenta_personal', 'false');
  assert.equal(hashRegistro(anterior), hashRegistro(plantilla));
  assert.notEqual(hashRegistro(fijarClave(plantilla, 'sandbox', 'modo', 'obligatorio')), hashRegistro(plantilla));

  const conservado = conservarAjustes(anterior, plantilla);
  assert.equal(leerClave(conservado, 'sandbox', 'lectura_denegada'), '[]');
  assert.equal(leerClave(conservado, 'sandbox', 'escritura_extra'), '["~/C#"]');
  assert.equal(leerClave(conservado, 'sandbox', 'preparar_con_credenciales'), 'true');
  assert.equal(leerClave(conservado, 'antigravity', 'permitir_cuenta_personal'), 'false');
  const parsed = YAML.parse(conservado);
  assert.deepEqual(parsed.sandbox.lectura_denegada, []);
  assert.deepEqual(parsed.sandbox.escritura_extra, ['~/C#']);
  assert.equal(parsed.sandbox.preparar_con_credenciales, true);

  // Valores con # entre comillas simples o dobles no se truncan ni pierden el comentario posterior
  const conComillas = [
    'sandbox:',
    '  lectura_extra: ["~/C#"] # comentario real',
    "  escritura_extra: ['~/C#''s', '~/F#'] # nota simple",
    '  preparar_con_credenciales: quizas',
    '',
  ].join('\n');
  assert.equal(leerClave(conComillas, 'sandbox', 'lectura_extra'), '["~/C#"]');
  assert.equal(leerClave(conComillas, 'sandbox', 'escritura_extra'), "['~/C#''s', '~/F#']");
  const actualizado = fijarClave(conComillas, 'sandbox', 'lectura_extra', '["~/D#", "~/E#"]');
  assert.match(actualizado, /^  lectura_extra: \["~\/D#", "~\/E#"\] # comentario real$/m);
  const sinInvalidos = conservarAjustes(conComillas, plantilla);
  assert.equal(leerClave(sinInvalidos, 'sandbox', 'lectura_extra'), '["~/C#"]');
  assert.equal(leerClave(sinInvalidos, 'sandbox', 'preparar_con_credenciales'), 'false');

  // Expansión de secciones declaradas con {}
  const vacia = 'sandbox: {} # config\nmodels: {}\n';
  const expandida = fijarClave(vacia, 'sandbox', 'preparar_con_credenciales', 'true');
  assert.equal(expandida, 'sandbox: # config\n  preparar_con_credenciales: true\nmodels: {}\n');
  assert.deepEqual(YAML.parse(expandida), { sandbox: { preparar_con_credenciales: true }, models: {} });
  assert.equal(leerClave(expandida, 'sandbox', 'preparar_con_credenciales'), 'true');
});

test('tareas y scorecard: toleran filas null, malformadas o sin fecha', () => {
  const dir = crearTemp('orq-jsonl-');
  const ruta = path.join(dir, 'delegaciones.jsonl');
  const valida = {
    tipo: 'delegacion', id: 'd1', tarea: 'd1', fecha: '2026-11-01T10:00:00Z',
    modelo: 'deepseek/deepseek-v4.1-flash-fast', rol: 'tests', effort: 'low', intento: 1, raiz: '/r', repo: 'r',
  };
  fs.writeFileSync(ruta, [
    'null',
    '{json roto',
    JSON.stringify({ tipo: 'delegacion', id: 'sin-fecha', modelo: 'deepseek/deepseek-v4.1-flash-fast', raiz: '/r', rol: 'tests' }),
    JSON.stringify({ tipo: 'revision', id: 'sin-fecha', resultado: 'aprobado' }),
    JSON.stringify(valida),
    JSON.stringify({ tipo: 'revision', id: 'd1', resultado: 'aprobado' }),
  ].join('\n'));
  const leidos = leerJsonl(ruta);
  const eventos = [...leidos, undefined, 42, [], { tipo: 'escalamiento', fecha: null, raiz: '/r', rol: 'tests' }];

  assert.equal(mapaRevisiones(eventos).get('d1'), 'aprobado');
  assert.equal(buscarTarea(eventos, '/r', 'sin-fecha'), null);
  assert.equal(buscarTarea(eventos, '/r', 'd1').tarea, 'd1');

  const resumen = resumirTareas(eventos);
  assert.equal(resumen.length, 1);
  assert.equal(resumen[0].estado, 'resuelta');

  const sc = calcularScorecard(eventos, cargarRegistro(MODELS));
  assert.equal(sc.totales.delegaciones, 1);
  assert.equal(sc.totales.tareas, 1);
  assert.equal(sc.escalamientos, 0);
});

test('tareas: resuelta_en se reinicia cuando un intento posterior es corregido y preserva revisiones tardías del intento 1', () => {
  const baseEv = { tipo: 'delegacion', tarea: 't1', raiz: '/r', rol: 'tests', modelo: 'deepseek/deepseek-v4.1-flash-fast', effort: 'low' };
  const evs = [
    { ...baseEv, id: 't1', intento: 1, fecha: '2026-11-01T00:00:00Z' },
    { tipo: 'revision', id: 't1', resultado: 'aprobado' },
    { ...baseEv, id: 't2', intento: 2, fecha: '2026-11-02T00:00:00Z' },
    { tipo: 'revision', id: 't2', resultado: 'corregido' },
  ];
  let [t] = resumirTareas(evs);
  assert.equal(t.resuelta_en, null);
  assert.equal(t.estado, 'abierta');
  assert.equal(t.ultima_revision, 'corregido');

  // Un tercer intento aprobado vuelve a marcarla resuelta en el intento 3
  evs.push({ ...baseEv, id: 't3', intento: 3, fecha: '2026-11-03T00:00:00Z' });
  evs.push({ tipo: 'revision', id: 't3', resultado: 'aprobado' });
  [t] = resumirTareas(evs);
  assert.equal(t.resuelta_en, 3);
  assert.equal(t.estado, 'resuelta');

  // Revisión tardía de intento 1 (corregido después de aprobar el intento 2) no pisa la resolución del intento 2
  const tardia = [
    { ...baseEv, id: 'a1', tarea: 'a1', intento: 1, fecha: '2026-11-01T00:00:00Z' },
    { tipo: 'revision', id: 'a1', resultado: 'corregido' },
    { ...baseEv, id: 'a2', tarea: 'a1', intento: 2, fecha: '2026-11-02T00:00:00Z' },
    { tipo: 'revision', id: 'a2', resultado: 'ajustado' },
    { tipo: 'revision', id: 'a1', resultado: 'corregido' },
  ];
  const [ta] = resumirTareas(tardia);
  assert.equal(ta.resuelta_en, 2);
  assert.equal(ta.estado, 'resuelta');
});

test('desdeComoIso rechaza fechas de calendario y formatos inválidos', () => {
  for (const mala of ['2026-13-01', '2026-02-31', '2025-02-29', '2026-04-31', '2026-00-10']) {
    assert.throws(
      () => desdeComoIso(mala),
      (e) => e.codigo === SALIDA.ERROR_USO && /Fecha inválida en --desde/.test(e.message),
      mala,
    );
  }
  for (const malFormato of ['2026/11/01', 'ayer', '2026-1-1']) {
    assert.throws(
      () => desdeComoIso(malFormato),
      (e) => e.codigo === SALIDA.ERROR_USO && /formato AAAA-MM-DD/.test(e.message),
      malFormato,
    );
  }
  assert.equal(new Date(desdeComoIso('2024-02-29')).getDate(), 29);
});

test('worktrees: detecta sinCommits, squash merge y ramas huérfanas', () => {
  const dir = fs.realpathSync(crearTemp('orq-wt-unit-'));
  const repo = path.join(dir, 'repo');
  const wtExt = path.join(dir, 'externo', 't1');
  const wtVacio = path.join(repo, '.claude', 'worktrees', 't2');
  fs.mkdirSync(repo, { recursive: true });
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t');
  g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'inicio');

  g(repo, 'worktree', 'add', '-q', '-b', 'delegar/t1', wtExt);
  fs.writeFileSync(path.join(wtExt, 'feature.txt'), 'cambio\n');
  g(wtExt, 'add', '-A');
  g(wtExt, 'commit', '-q', '-m', 'delegar(tests): t1');

  g(repo, 'worktree', 'add', '-q', '-b', 'delegar/t2', wtVacio);
  g(repo, 'branch', 'delegar/huerfana');

  let lista = worktreesDelegacion(repo);
  const t1 = lista.find((w) => w.id === 't1');
  const t2 = lista.find((w) => w.id === 't2');
  assert.equal(t1.integrada, false);
  assert.equal(t1.sinCommits, false);
  assert.ok(t1.relativa.startsWith('..'));
  assert.equal(t1.rutaCorta, wtExt);
  assert.equal(t2.integrada, false);
  assert.equal(t2.sinCommits, true);
  assert.equal(t2.rutaCorta, path.join('.claude', 'worktrees', 't2'));

  assert.deepEqual(
    ramasDelegacionHuerfanas(repo).map(({ rama, id, integrada, sinCommits }) => ({ rama, id, integrada, sinCommits })),
    [{ rama: 'delegar/huerfana', id: 'huerfana', integrada: false, sinCommits: true }],
  );

  // Squash merge en main hace que t1 figure integrada aunque su rama no sea ancestro
  g(repo, 'merge', '--squash', '-q', 'delegar/t1');
  g(repo, 'commit', '-q', '-m', 'squash t1');
  lista = worktreesDelegacion(repo);
  assert.equal(lista.find((w) => w.id === 't1').integrada, true);
});
