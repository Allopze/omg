import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cargarRegistro, validarRegistro, resolverDelegacion, construirPrompt,
  archivosFueraDeRutas, archivosDeConfiguracion, subagenteNativo, extraerUso, tokensTotales, SALIDA,
} from '../lib/registro.mjs';
import {
  construirArgs, EJECUTORES, ejecutorRequerido, catalogoContiene, salidaJsonEfectiva,
} from '../lib/ejecutores/index.mjs';
import { crearLectorAgy, antigravity } from '../lib/ejecutores/antigravity.mjs';
import { commandCode } from '../lib/ejecutores/command-code.mjs';
import { calcularScorecard } from '../comandos/scorecard.mjs';
import { crearLectorJson } from '../lib/salida-cmd.mjs';
import { buscarTarea, tareaDe } from '../lib/tareas.mjs';

const RUTA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.yaml');
const base = () => ({ ...structuredClone(cargarRegistro(RUTA)), repo: { sensible: false } });
const ID = 'deepseek/deepseek-v4.1-flash-fast';
const tempDirs = [];

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('el models.yaml incluido es válido', () => {
  assert.doesNotThrow(() => cargarRegistro(RUTA));
});

test('rechaza un effort que el modelo no acepta', () => {
  const r = base();
  r.roles.implementar.effort = 'medium';
  assert.throws(() => validarRegistro(r), /effort = "medium" no está en/);
});

test('rechaza patrones de repos sensibles mal formados', () => {
  const r = base();
  r.repos_sensibles.remotos = 'privado';
  assert.throws(() => validarRegistro(r), /repos_sensibles.remotos/);
});

test('rechaza "default" en efforts_aceptados', () => {
  const r = base();
  r.models[ID].efforts_aceptados.push('default');
  assert.throws(() => validarRegistro(r), /no debe incluir "default"/);
});

test('rechaza un escalamiento nativo desconocido', () => {
  const r = base();
  r.roles.tests.escala_a = ['nativo:gpt'];
  assert.throws(() => validarRegistro(r), /no es un modelo nativo/);
});

test('rechaza yolo en un modelo de solo lectura', () => {
  const r = base();
  r.models[ID].permisos = 'lectura';
  assert.throws(() => validarRegistro(r), /yolo: true pero/);
});

test('intento 1 usa effort base e intento 2 effort de reintento', () => {
  const r = base();
  assert.equal(resolverDelegacion(r, { rol: 'implementar', intento: 1 }).effort, 'high');
  assert.equal(resolverDelegacion(r, { rol: 'implementar', intento: 2 }).effort, 'max');
  assert.equal(resolverDelegacion(r, { rol: 'documentar', intento: 1 }).effort, 'off');
});

test('pide escalar cuando se agotan los intentos', () => {
  const res = resolverDelegacion(base(), { rol: 'implementar', intento: 3 });
  assert.equal(res.accion, 'escalar');
  assert.deepEqual(res.escala_a, ['nativo:sonnet']);
});

test('bloquea modelos fuera de la whitelist del rol', () => {
  assert.throws(
    () => resolverDelegacion(base(), { rol: 'implementar', modelo: 'meta/muse-spark-1.3-contributor' }),
    (e) => e.codigo === SALIDA.BLOQUEADO,
  );
});

test('bloquea modelos retirados', () => {
  const r = base();
  r.models[ID].estado = 'retirado';
  assert.throws(() => resolverDelegacion(r, { rol: 'implementar' }), /retirado/);
});

test('bloquea Command Code en repos sensibles salvo repos_sensibles: permitido', () => {
  const r = base();
  r.repo.sensible = true;
  assert.throws(() => resolverDelegacion(r, { rol: 'implementar' }), (e) => e.codigo === SALIDA.BLOQUEADO);
  r.models[ID].repos_sensibles = 'permitido';
  assert.equal(resolverDelegacion(r, { rol: 'implementar' }).accion, 'delegar');
});

test('omite skills si skills_compatibles no es true', () => {
  const r = base();
  r.roles.implementar.skills = ['.claude/skills/x'];
  const sin = resolverDelegacion(r, { rol: 'implementar' });
  assert.deepEqual(sin.skills, []);
  assert.deepEqual(sin.skills_omitidas, ['.claude/skills/x']);
  r.command_code.skills_compatibles = true;
  const con = resolverDelegacion(r, { rol: 'implementar' });
  assert.deepEqual(con.skills, ['.claude/skills/x']);
  assert.deepEqual(con.skills_omitidas, []);
});

test('construye los argumentos de cmd', () => {
  const r = base();
  const res = resolverDelegacion(r, { rol: 'implementar' });
  assert.deepEqual(construirArgs(res, ['/abs/skill']), [
    '-p', '--model', ID, '--effort', 'high', '--yolo', '--skill', '/abs/skill', '--skip-onboarding',
  ]);
  const lectura = resolverDelegacion(r, { rol: 'analizar' });
  assert.ok(!construirArgs(lectura).includes('--yolo'));
  r.command_code.salida_json = true;
  assert.deepEqual(construirArgs(resolverDelegacion(r, { rol: 'tests' })).slice(-3), ['--output-format', 'json', '--skip-onboarding']);
});

test('valida sandbox, ejecutores, salida_json, timeout y worktrees', () => {
  const casos = [
    [(r) => { r.sandbox.modo = 'a-veces'; }, /sandbox\.modo debe ser auto \| obligatorio \| desactivado/],
    [(r) => { r.sandbox.escritura_extra = '~/x'; }, /escritura_extra debe ser una lista/],
    [(r) => { r.sandbox.lectura_extra = '~/x'; }, /lectura_extra debe ser una lista/],
    [(r) => { r.command_code.salida_json = 'si'; }, /salida_json debe ser true, false o null/],
    [(r) => { r.command_code.timeout_min = 0; }, /command_code\.timeout_min debe ser un número mayor que 0/],
    [(r) => { r.antigravity.timeout_min = -1; }, /antigravity\.timeout_min debe ser un número mayor que 0/],
    [(r) => { r.antigravity.permitir_cuenta_personal = 'si'; }, /permitir_cuenta_personal debe ser true o false/],
    [(r) => { r.worktrees.ubicacion = 'nube'; }, /worktrees\.ubicacion debe ser repo \| externa/],
    [(r) => { r.command_code.sandbox = { modo: 'auto' }; }, /quita command_code\.sandbox/],
  ];
  for (const [romper, error] of casos) {
    const r = base();
    romper(r);
    assert.throws(() => validarRegistro(r), error);
  }
  // un registro de la 0.2, sin las secciones nuevas, sigue siendo válido
  const viejo = base();
  for (const k of ['sandbox', 'worktrees', 'antigravity']) delete viejo[k];
  delete viejo.command_code.salida_json;
  for (const id of Object.keys(viejo.models)) if (id.startsWith('antigravity/')) delete viejo.models[id];
  for (const rol of Object.values(viejo.roles)) rol.permitidos = rol.permitidos.filter((m) => !m.startsWith('antigravity/'));
  assert.doesNotThrow(() => validarRegistro(viejo));
  // y el sandbox de la 0.3 (command_code.sandbox) se sigue aceptando
  viejo.command_code.sandbox = { modo: 'desactivado' };
  assert.doesNotThrow(() => validarRegistro(viejo));
});

test('modelos de Antigravity: efforts mapea niveles a slugs y resolverDelegacion elige el slug', () => {
  const AG = 'antigravity/gemini-4-neon';
  for (const [romper, error] of [
    [(f) => { delete f.efforts; }, /efforts debe mapear cada nivel/],
    [(f) => { f.efforts.high = 3; }, /efforts\.high debe ser un slug/],
    [(f) => { f.efforts_aceptados = ['low']; }, /declaran \`efforts\`/],
    [(f) => { f.ejecutor = 'otro'; }, /ejecutor debe ser command_code \| antigravity/],
    [(f) => { delete f.efforts.max; }, /effort_reintento = "max" no está en models\.antigravity\/gemini-4-neon\.efforts/],
  ]) {
    const r = base();
    romper(r.models[AG]);
    assert.throws(() => validarRegistro(r), error);
  }
  const r = base();
  const res = resolverDelegacion(r, { rol: 'implementar', modelo: AG });
  assert.equal(res.ejecutor, 'antigravity');
  assert.equal(res.slug, 'gemini-4-neon-high');
  assert.equal(res.salida_json, true);
  assert.deepEqual(construirArgs(res), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-4-neon-high', '--dangerously-skip-permissions',
  ]);
  const lectura = resolverDelegacion(r, { rol: 'analizar', modelo: 'antigravity/gemini-4-hydrogen' });
  assert.equal(lectura.slug, 'gemini-4-hydrogen-medium');
  assert.deepEqual(construirArgs(lectura).slice(-2), ['--mode', 'plan'], 'solo lectura: sin --mode plan, agy escribe');
  // agy no recibe skills por flag, aunque Command Code sí las acepte
  r.command_code.skills_compatibles = true;
  r.roles.implementar.skills = ['.claude/skills/x'];
  const conSkills = resolverDelegacion(r, { rol: 'implementar', modelo: AG });
  assert.deepEqual([conSkills.skills, conSkills.skills_omitidas], [[], ['.claude/skills/x']]);
});

test('lee el stream de agy: resultado, tokens, herramientas y estados de error', () => {
  const l = crearLectorAgy();
  l.agregar('{"event":"init","conversation_id":"c"}\n{"event":"step_update","step_update":{"state":"ACTIVE","tool_name":"write_file"}}\n');
  l.agregar('{"event":"step_update","step_update":{"state":"DONE","tool_name":"write_file"}}\n');
  l.agregar('{"event":"result","result":{"status":"SUCCESS","response":"Listo","usage":{"input_tokens":10,"output_tokens":2,"thinking_tokens":1,"cache_read_tokens":5,"total_tokens":12}}}');
  const j = l.terminar();
  assert.equal(j.texto, 'Listo');
  assert.equal(j.error, null);
  assert.deepEqual(j.uso, { entrada: 10, salida: 2, razonamiento: 1, cache: 5, total: 12, costo: null });
  assert.deepEqual(j.herramientas, { write_file: 1 });
  const e = crearLectorAgy();
  e.agregar('{"event":"result","result":{"status":"ERROR","response":"","error":"cuota agotada"}}\n');
  assert.equal(e.terminar().error, 'estado ERROR: cuota agotada');
});

test('extrae tokens del usage de Command Code y lee el stream JSON', () => {
  const nulos = { entrada: null, salida: null, razonamiento: null, cache: null, total: null, costo: null };
  assert.deepEqual(extraerUso({ inputTokens: 10, outputTokens: 2 }), { ...nulos, entrada: 10, salida: 2 });
  assert.deepEqual(extraerUso({ input_tokens: 5, output_tokens: 1, cost_usd: 0.01 }), { ...nulos, entrada: 5, salida: 1, costo: 0.01 });
  assert.equal(tokensTotales(extraerUso({ input_tokens: 5, output_tokens: 1, thinking_tokens: 2 })), 8);
  assert.equal(tokensTotales(extraerUso({ input_tokens: 5, output_tokens: 1, total_tokens: 6, cache_read_tokens: 99 })), 6);
  assert.equal(extraerUso({ otra: 'cosa' }), null);
  assert.equal(extraerUso(undefined), null);

  const lector = crearLectorJson();
  const stream = [
    '{"type":"event","event":{"type":"tool_running","toolName":"read_file"}}',
    'aviso suelto que no es JSON',
    '{"type":"event","event":{"type":"tool_running","toolName":"read_file"}}',
    '{"type":"result","subtype":"success","usage":{"inputTokens":7,"outputTokens":3},"durationMs":5,"finalText":"Listo"}',
  ].join('\n');
  lector.agregar(stream.slice(0, 40));
  lector.agregar(stream.slice(40));
  const j = lector.terminar();
  assert.equal(j.texto, 'Listo');
  assert.deepEqual(j.uso, { ...nulos, entrada: 7, salida: 3 });
  assert.deepEqual(j.herramientas, { read_file: 2 });
});

test('detecta diffs que tocan configuración de agentes, CI o git', () => {
  assert.deepEqual(
    archivosDeConfiguracion(['src/a.js', '.claude/settings.json', '.github/workflows/ci.yml', 'pkg/.npmrc', 'docs/AGENTS.md', '.husky/pre-commit']),
    ['.claude/settings.json', '.github/workflows/ci.yml', 'pkg/.npmrc', 'docs/AGENTS.md', '.husky/pre-commit'],
  );
});

test('tareas: agrupa intentos, incluso los de logs antiguos sin campo tarea', () => {
  const raiz = '/r';
  const eventos = [
    { tipo: 'delegacion', id: 'a1', fecha: '2026-01-01', raiz, rol: 'tests', worktree: '.claude/worktrees/a1' },
    { tipo: 'delegacion', id: 'a2', fecha: '2026-01-02', raiz, rol: 'tests', worktree: '.claude/worktrees/a1' },
    { tipo: 'delegacion', id: 'b1', tarea: 'b1', fecha: '2026-01-03', raiz, rol: 'tests', worktree: '.claude/worktrees/b1' },
    { tipo: 'delegacion', id: 'b2', tarea: 'b1', fecha: '2026-01-04', raiz, rol: 'tests', worktree: '.claude/worktrees/b1' },
    { tipo: 'delegacion', id: 'c1', fecha: '2026-01-05', raiz: '/otro', rol: 'tests', worktree: null },
  ];
  assert.equal(tareaDe(eventos[1]), 'a1');
  assert.deepEqual(buscarTarea(eventos, raiz, 'a2').intentos.map((e) => e.id), ['a1', 'a2']);
  assert.deepEqual(buscarTarea(eventos, raiz, 'b1').intentos.map((e) => e.id), ['b1', 'b2']);
  assert.equal(buscarTarea(eventos, raiz, '.claude/worktrees/b1').tarea, 'b1');
  assert.equal(buscarTarea(eventos, raiz, 'c1'), null, 'no busca en otros repos');
  assert.equal(buscarTarea(eventos, raiz, '.'), null);
});

test('el preámbulo declara límites del rol', () => {
  const r = base();
  const p = construirPrompt(resolverDelegacion(r, { rol: 'documentar' }), 'Documenta X');
  assert.match(p, /bajo: docs\//);
  assert.match(p, /máximo 20 archivos/);
  assert.match(construirPrompt(resolverDelegacion(r, { rol: 'analizar' }), 'Y'), /Solo lectura/);
});

test('detecta archivos fuera de las rutas permitidas', () => {
  assert.deepEqual(archivosFueraDeRutas(['docs/a.md', 'docs', 'src/b.js', 'docsx/c.md'], ['docs/']), ['src/b.js', 'docsx/c.md']);
  assert.deepEqual(archivosFueraDeRutas(['src/b.js'], null), []);
});

test('mapea escalamientos nativos a subagentes', () => {
  assert.equal(subagenteNativo('nativo:sonnet', true), 'implementador-sonnet');
  assert.equal(subagenteNativo('nativo:sonnet', false), 'analista-sonnet');
  assert.equal(subagenteNativo('nativo:haiku', true), 'documentador-haiku');
});

test('el preámbulo de escritura prohíbe tocar .git y dejar procesos corriendo', () => {
  const p = construirPrompt(resolverDelegacion(base(), { rol: 'implementar' }), 'X');
  assert.match(p, /no modifiques \.git/);
  assert.match(p, /No dejes procesos corriendo/);
});

test('el scorecard cuenta ajustado como aprobado y resume por tarea', () => {
  const r = base();
  const eventos = [
    { tipo: 'delegacion', id: 't1', tarea: 't1', fecha: '2026-11-01', modelo: ID, rol: 'tests', effort: 'low', intento: 1, raiz: '/a', uso: { entrada: 100, salida: 10, costo: null }, validacion: { ok: false } },
    { tipo: 'revision', id: 't1', resultado: 'corregido' },
    { tipo: 'delegacion', id: 't2', tarea: 't1', fecha: '2026-11-02', modelo: ID, rol: 'tests', effort: 'high', intento: 2, raiz: '/a', uso: { entrada: 200, salida: 20, costo: null }, validacion: { ok: true } },
    { tipo: 'revision', id: 't2', resultado: 'ajustado' },
    { tipo: 'delegacion', id: 'u1', tarea: 'u1', fecha: '2026-11-03', modelo: ID, rol: 'tests', effort: 'low', intento: 1, raiz: '/b' },
    { tipo: 'revision', id: 'u1', resultado: 'aprobado' },
    { tipo: 'delegacion', id: 'v1', tarea: 'v1', fecha: '2026-11-04', modelo: ID, rol: 'tests', effort: 'low', intento: 1, raiz: '/b' },
  ];
  const s = calcularScorecard(eventos, r);
  const t = s.tareas.find((x) => x.rol === 'tests');
  assert.equal(t.tareas, 3);
  assert.equal(t.resueltas_primer_intento, 1);
  assert.equal(t.resueltas_con_reintento, 1);
  assert.equal(t.abiertas, 1);
  assert.equal(t.tokens_por_tarea, 330);
  assert.equal(s.totales.tokens, 330);
  assert.equal(s.totales.ajustadas, 1);
  const low = s.filas.find((f) => f.effort === 'low');
  assert.equal(low.tasa_validacion, 0);
  assert.equal(s.filas.find((f) => f.effort === 'high').tasa_aprobacion, 1, 'ajustado cuenta como aprobado');
  assert.equal(calcularScorecard(eventos, r, { raiz: '/b' }).totales.delegaciones, 2);
});

test('el scorecard sugiere promover, degradar y sumar un segundo modelo', () => {
  const r = base();
  r.models[ID].estado = 'en_prueba';
  const eventos = [];
  for (let i = 0; i < 6; i++) {
    const id = `p${i}`;
    eventos.push({ tipo: 'delegacion', id, fecha: `2026-11-0${i + 1}T00:00:00Z`, modelo: ID, rol: 'tests', effort: 'low', intento: 1, skills: [], alertas: [], duracion_ms: 60000 });
    eventos.push({ tipo: 'revision', id, resultado: 'aprobado' });
  }
  let s = calcularScorecard(eventos, r);
  assert.ok(s.sugerencias.some((x) => x.startsWith(`Promover ${ID}`)));
  assert.equal(s.filas[0].tasa_primer_intento, 1);

  r.models[ID].estado = 'activo';
  const malas = [];
  for (let i = 0; i < 10; i++) {
    const id = `m${i}`;
    malas.push({ tipo: 'delegacion', id, fecha: `2026-11-1${i}T00:00:00Z`, modelo: ID, rol: 'implementar', effort: 'high', intento: 1, skills: [], alertas: [], duracion_ms: 1 });
    malas.push({ tipo: 'revision', id, resultado: 'corregido' });
    malas.push({ tipo: 'escalamiento', id: `e${i}`, fecha: `2026-11-1${i}T01:00:00Z`, rol: 'implementar' });
  }
  s = calcularScorecard(malas, r);
  assert.ok(s.sugerencias.some((x) => x.startsWith(`Pasar ${ID} a en_prueba`)));
  assert.ok(s.sugerencias.some((x) => x.includes('Rol "implementar"')));
});

test('rechaza claves desconocidas anidadas y valida preparar_con_credenciales', () => {
  const casos = [
    [(r) => { r.sandbox.escrituras_extra = []; }, /Claves desconocidas en sandbox: escrituras_extra/],
    [(r) => { r.antigravity.cuenta_personal = true; }, /Claves desconocidas en antigravity: cuenta_personal/],
    [(r) => { r.command_code.habilitar_skills = true; }, /Claves desconocidas en command_code: habilitar_skills/],
    [(r) => { r.repos_sensibles.carpetas = []; }, /Claves desconocidas en repos_sensibles: carpetas/],
    [(r) => { r.worktrees.carpeta = '~/x'; }, /Claves desconocidas en worktrees: carpeta/],
    [(r) => { r.models[ID].extra = 1; }, new RegExp(`Claves desconocidas en models\\.${ID}: extra`)],
    [(r) => { r.roles.implementar.extra = 1; }, /Claves desconocidas en roles\.implementar: extra/],
    [(r) => { r.umbrales.extra = 1; }, /Claves desconocidas en umbrales: extra/],
    [(r) => { r.umbrales.promocion.extra = 1; }, /Claves desconocidas en umbrales\.promocion: extra/],
    [(r) => { r.umbrales.degradacion.extra = 1; }, /Claves desconocidas en umbrales\.degradacion: extra/],
    [(r) => { r.umbrales.segundo_modelo.extra = 1; }, /Claves desconocidas en umbrales\.segundo_modelo: extra/],
    [(r) => { r.sandbox.preparar_con_credenciales = 'si'; }, /sandbox\.preparar_con_credenciales debe ser true o false/],
  ];
  for (const [romper, error] of casos) {
    const r = base();
    romper(r);
    assert.throws(() => validarRegistro(r), error);
  }
});

test('rechaza secciones no-objeto (repos_sensibles, worktrees, ejecutores, sandbox, umbrales) y acepta null', () => {
  for (const [romper, error] of [
    [(r) => { r.repos_sensibles = []; }, /repos_sensibles debe ser un objeto/],
    [(r) => { r.repos_sensibles = 'ninguno'; }, /repos_sensibles debe ser un objeto/],
    [(r) => { r.worktrees = []; }, /worktrees debe ser un objeto/],
    [(r) => { r.worktrees = 'repo'; }, /worktrees debe ser un objeto/],
    [(r) => { r.command_code = 'cmd'; }, /command_code debe ser un objeto/],
    [(r) => { r.antigravity = 42; }, /antigravity debe ser un objeto/],
    [(r) => { r.sandbox = true; }, /sandbox debe ser un objeto/],
    [(r) => { r.umbrales = []; }, /umbrales debe ser un objeto/],
  ]) {
    const r = base();
    romper(r);
    assert.throws(() => validarRegistro(r), error);
  }
  const conNulos = base();
  conNulos.repos_sensibles = null;
  conNulos.worktrees = null;
  conNulos.sandbox = null;
  conNulos.antigravity = null;
  assert.doesNotThrow(() => validarRegistro(conNulos));
});

test('command_code soporta mapa opcional efforts:, rechaza mezclarlo con efforts_aceptados y traduce effort_cli', () => {
  const r = base();
  delete r.models[ID].efforts_aceptados;
  r.models[ID].efforts = { off: 'none', low: 'low', high: 'high', max: 'xhigh' };
  assert.doesNotThrow(() => validarRegistro(r));

  const res1 = resolverDelegacion(r, { rol: 'implementar', intento: 1 });
  assert.equal(res1.effort, 'high');
  assert.equal(res1.effort_cli, 'high');
  assert.equal(res1.slug, null);

  const res2 = resolverDelegacion(r, { rol: 'implementar', intento: 2 });
  assert.equal(res2.effort, 'max');
  assert.equal(res2.effort_cli, 'xhigh');
  assert.deepEqual(construirArgs(res2), ['-p', '--model', ID, '--effort', 'xhigh', '--yolo', '--skip-onboarding']);

  const lectura = resolverDelegacion(r, { rol: 'analizar' });
  assert.deepEqual(commandCode.args(lectura, [], { plan: true, sinSesion: true }), [
    '-p', '--model', ID, '--effort', 'low', '--plan', '--no-session', '--no-auto-update', '--skip-onboarding',
  ]);
  assert.ok(!commandCode.args(res1, [], { plan: true }).includes('--plan'), 'solo lectura usa --plan');

  for (const [romper, error] of [
    [(m) => { m.efforts_aceptados = ['high']; }, /declara `efforts` o `efforts_aceptados`, no ambos/],
    [(m) => { m.efforts = {}; }, /efforts debe mapear cada nivel de effort de orq a un nivel de cmd/],
    [(m) => { m.efforts.high = 3; }, /efforts\.high debe ser un nivel de effort de cmd/],
    [(m) => { delete m.efforts.max; }, /effort_reintento = "max" no está en models\..*\.efforts/],
  ]) {
    const mal = structuredClone(r);
    romper(mal.models[ID]);
    assert.throws(() => validarRegistro(mal), error);
  }
});

test('ejecutorRequerido, catalogoContiene (token completo) y salidaJsonEfectiva', () => {
  const r = base();
  assert.equal(ejecutorRequerido(r, EJECUTORES.command_code), true);
  assert.equal(ejecutorRequerido(r, EJECUTORES.antigravity), false);
  r.roles.frontend.primario = 'antigravity/gemini-4-neon';
  assert.equal(ejecutorRequerido(r, EJECUTORES.antigravity), true);
  assert.equal(ejecutorRequerido({}, EJECUTORES.antigravity), false);

  assert.equal(catalogoContiene('  deepseek/deepseek-v4.1-flash-fast\n', ID), true);
  assert.equal(catalogoContiene('modelos: a, gemini-4-neon-low; otro', 'gemini-4-neon-low'), true);
  assert.equal(catalogoContiene('gemini-4-neon-high-preview\ngemini-4-neon-xhigh', 'gemini-4-neon-high'), false);
  assert.equal(catalogoContiene('deepseek/deepseek-v4.1-flash-fast-2', ID), false);
  assert.equal(catalogoContiene('prefijo-deepseek/deepseek-v4.1-flash-fast', ID), false);
  assert.equal(catalogoContiene('model-v4x1', 'model-v4.1'), false);
  assert.equal(catalogoContiene('model-v4.1', 'model-v4.1'), true);
  assert.equal(catalogoContiene('', ID), false);
  assert.equal(catalogoContiene('abc', ''), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-reg-bins-'));
  tempDirs.push(dir);
  const crearBin = (nombre, script) => {
    const p = path.join(dir, nombre);
    fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return p;
  };
  const binNuevo = crearBin('cmd-nuevo', 'echo "1.84.0"');
  const binViejo = crearBin('cmd-viejo', 'echo "0.26.21"');
  const binFalla = crearBin('cmd-falla', 'echo "boom" >&2; exit 1');

  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.antigravity, '/no/existe'), { activo: true, automatico: false, version: null });
  r.command_code.salida_json = true;
  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.command_code, '/no/existe'), { activo: true, automatico: false, version: null });
  r.command_code.salida_json = false;
  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.command_code, binNuevo), { activo: false, automatico: false, version: null });

  r.command_code.salida_json = null;
  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.command_code, binNuevo), { activo: true, automatico: true, version: '1.84.0' });
  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.command_code, binViejo), { activo: false, automatico: false, version: '0.26.21' });
  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.command_code, binFalla), { activo: false, automatico: false, version: null });
  assert.deepEqual(salidaJsonEfectiva(r, EJECUTORES.command_code, path.join(dir, 'inexistente')), { activo: false, automatico: false, version: null });
});

test('salida-cmd (crearLectorJson): UTF-8 partido en chunks, max_turns, error, stdoutCola, coerción y alEvento', () => {
  const eventos = [];
  const l = commandCode.lector({ salida_json: true }, { alEvento: (ev) => eventos.push(ev) });
  const lineaUtf8 = Buffer.from(
    '{"type":"result","subtype":"success","finalText":"árbol ñandú 🚀 listo"}\n',
    'utf8',
  );
  // Corta exactamente dentro de "á", "ñ" y "🚀" (4 bytes en UTF-8)
  const posCohete = lineaUtf8.indexOf(Buffer.from('🚀', 'utf8'));
  const cortes = [15, posCohete + 2];
  l.agregar(lineaUtf8.subarray(0, cortes[0]));
  l.agregar(lineaUtf8.subarray(cortes[0], cortes[1]));
  l.agregar(lineaUtf8.subarray(cortes[1]));
  assert.equal(l.terminar().texto, 'árbol ñandú 🚀 listo');

  const mt = crearLectorJson({ alEvento: (ev) => eventos.push(ev) });
  for (let i = 1; i <= 12; i++) mt.agregar(`  aviso ${i}  \n\n`);
  mt.agregar('{"type":"event","event":{"type":"tool_running","toolName":"grep"}}\n');
  mt.agregar('{"type":"result","subtype":"max_turns","finalText":42}');
  const rMt = mt.terminar();
  assert.equal(rMt.error, 'max_turns');
  assert.equal(rMt.subtipo, 'max_turns');
  assert.equal(rMt.texto, '42');
  assert.deepEqual(rMt.stdoutCola, Array.from({ length: 10 }, (_, idx) => `aviso ${idx + 3}`));
  assert.deepEqual(eventos, [{ tipo: 'herramienta', nombre: 'grep' }]);

  const errTop = crearLectorJson();
  errTop.agregar('{"type":"error","error":{"message":"rate limit"}}\n');
  const rErr = errTop.terminar();
  assert.equal(rErr.error, 'rate limit');
  assert.equal(rErr.texto, '');

  const nulo = crearLectorJson();
  nulo.agregar('{"type":"result","subtype":"success","finalText":null}\n');
  assert.equal(nulo.terminar().texto, '');
});

test('antigravity (crearLectorAgy y adaptador): UTF-8 partido, error sin result, stdoutCola, coerción, alEvento y settings', () => {
  const eventos = [];
  const l = antigravity.lector({}, { alEvento: (ev) => eventos.push(ev) });
  const linea = Buffer.from('{"event":"result","result":{"status":"SUCCESS","response":"café ñandú 🚀"}}\n', 'utf8');
  const posCohete = linea.indexOf(Buffer.from('🚀', 'utf8'));
  l.agregar(Buffer.from('{"event":"step_update","step_update":{"state":"ACTIVE","tool_name":"read_file"}}\n', 'utf8'));
  l.agregar(Buffer.from('{"event":"step_update","step_update":{"state":"DONE","tool_name":"read_file"}}\n', 'utf8'));
  l.agregar(linea.subarray(0, posCohete + 1));
  l.agregar(linea.subarray(posCohete + 1, posCohete + 3));
  l.agregar(linea.subarray(posCohete + 3));
  const res = l.terminar();
  assert.equal(res.texto, 'café ñandú 🚀');
  assert.deepEqual(res.herramientas, { read_file: 1 });
  assert.deepEqual(eventos, [
    { tipo: 'herramienta', nombre: 'read_file' },
    { tipo: 'herramienta', nombre: 'read_file' },
  ]);

  const errSinRes = crearLectorAgy();
  for (let i = 1; i <= 11; i++) errSinRes.agregar(`stderr-en-stdout ${i}\n`);
  errSinRes.agregar('{"event":"error","error":{"message":"token expirado"}}\n');
  const rErr = errSinRes.terminar();
  assert.equal(rErr.error, 'token expirado');
  assert.equal(rErr.texto, '');
  assert.deepEqual(rErr.stdoutCola, Array.from({ length: 10 }, (_, idx) => `stderr-en-stdout ${idx + 2}`));

  const numResp = crearLectorAgy();
  numResp.agregar('{"event":"result","result":{"status":"FAILED","response":99}}\n');
  const rNum = numResp.terminar();
  assert.equal(rNum.texto, '99');
  assert.equal(rNum.error, 'estado FAILED');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-agy-unit-'));
  tempDirs.push(dir);
  const badSettings = path.join(dir, 'settings.json');
  fs.writeFileSync(badSettings, '{ invalido');
  const prevSettings = process.env.ORQ_AGY_SETTINGS;
  const prevAgyBin = process.env.ORQ_AGY_BIN;
  const prevCmdBin = process.env.ORQ_CMD_BIN;
  try {
    process.env.ORQ_AGY_SETTINGS = badSettings;
    process.env.ORQ_AGY_BIN = '~/bin/agy';
    process.env.ORQ_CMD_BIN = '~/bin/cmd';
    assert.equal(antigravity.bin({}), path.join(os.homedir(), 'bin', 'agy'));
    assert.equal(commandCode.bin({}), path.join(os.homedir(), 'bin', 'cmd'));
    const acc = antigravity.acceso({ antigravity: { permitir_cuenta_personal: false } });
    assert.equal(acc.modo, 'cuenta_personal');
    assert.match(acc.avisoSettings, /no es JSON válido/);
    assert.ok(acc.bloqueo);
  } finally {
    if (prevSettings === undefined) delete process.env.ORQ_AGY_SETTINGS;
    else process.env.ORQ_AGY_SETTINGS = prevSettings;
    if (prevAgyBin === undefined) delete process.env.ORQ_AGY_BIN;
    else process.env.ORQ_AGY_BIN = prevAgyBin;
    if (prevCmdBin === undefined) delete process.env.ORQ_CMD_BIN;
    else process.env.ORQ_CMD_BIN = prevCmdBin;
  }
});
