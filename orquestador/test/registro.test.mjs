import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cargarRegistro, validarRegistro, resolverDelegacion, construirPrompt,
  archivosFueraDeRutas, archivosDeConfiguracion, subagenteNativo, extraerUso, tokensTotales, SALIDA,
} from '../lib/registro.mjs';
import { construirArgs } from '../lib/ejecutores/index.mjs';
import { crearLectorAgy } from '../lib/ejecutores/antigravity.mjs';
import { calcularScorecard } from '../comandos/scorecard.mjs';
import { crearLectorJson } from '../lib/salida-cmd.mjs';
import { buscarTarea, tareaDe } from '../lib/tareas.mjs';

const RUTA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.yaml');
const base = () => ({ ...structuredClone(cargarRegistro(RUTA)), repo: { sensible: false } });
const ID = 'deepseek/deepseek-v4.1-flash-fast';

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
