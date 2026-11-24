import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MAC, entorno, orq, eventos, delegaciones, llamadas, git, procesoVivo, ajustesRepo, permitirCuentaPersonal,
} from './ayuda.mjs';

test('orq sin argumentos muestra la ayuda y rechaza comandos desconocidos', () => {
  const ctx = entorno();
  assert.match(orq(ctx, []).salida, /Uso: orq <comando>/);
  assert.equal(orq(ctx, ['inventado']).codigo, 2);
  assert.equal(orq(ctx, ['generar-skill']).codigo, 2);
  assert.match(orq(ctx, ['--version']).salida, /^\d+\.\d+\.\d+/);
});

test('ciclo completo: delegar, revisar, continuar, escalar, integrar y limpiar', () => {
  const ctx = entorno();
  const r = orq(ctx, ['delegar', 'implementar', '--fase', 'Fase 1'], { entrada: 'Agrega docs.' });
  assert.equal(r.codigo, 0, r.error + r.salida);

  const [llamada] = llamadas(ctx);
  assert.deepEqual(llamada.args, ['-p', '--model', 'deepseek/deepseek-v4.1-flash-fast', '--effort', 'high', '--yolo', '--skip-onboarding']);
  assert.match(llamada.cwd, /\.claude\/worktrees\//);
  assert.match(llamada.entrada, /rol: implementar · intento 1\/2/);

  // el worktree no ensucia el repo principal: se excluye en .git/info/exclude, sin tocar .gitignore
  assert.match(fs.readFileSync(path.join(ctx.repo, '.git', 'info', 'exclude'), 'utf8'), /\.claude\/worktrees\//);
  assert.equal(git(ctx, 'status', '--porcelain').trim(), '');
  assert.ok(!fs.existsSync(path.join(ctx.repo, '.gitignore')));

  const [ev] = delegaciones(ctx);
  assert.equal(ev.tarea, ev.id);
  assert.equal(ev.intento, 1);
  assert.equal(ev.effort, 'high');
  assert.equal(ev.repo, 'repo');
  assert.equal(ev.sensible, false);
  assert.equal(ev.archivos.length, 1);
  assert.deepEqual(ev.criticas, []);
  if (MAC) assert.equal(ev.sandbox, 'sandbox-exec');
  assert.match(fs.readFileSync(ev.prompt, 'utf8'), /Agrega docs\./);
  assert.match(r.salida, /registrar revisión: orq revision .* aprobado\|ajustado\|corregido/);
  assert.match(r.salida, new RegExp(`reintento: orq delegar implementar --continuar ${ev.tarea}`));

  assert.equal(orq(ctx, ['revision', ev.id, 'corregido', '--nota', 'faltan tests']).codigo, 0);
  const r2 = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'Corrige.' });
  assert.equal(r2.codigo, 0, r2.error + r2.salida);
  const ev2 = delegaciones(ctx)[1];
  assert.equal(ev2.tarea, ev.tarea);
  assert.equal(ev2.intento, 2);
  assert.equal(ev2.effort, 'max');
  assert.equal(ev2.fase, 'Fase 1');
  assert.equal(ev2.worktree, ev.worktree);
  assert.equal(ev2.archivos.length, 1);
  assert.equal(ev2.archivos_acumulados.length, 2);
  assert.equal(orq(ctx, ['revision', ev2.id, 'aprobado']).codigo, 0);

  // el tercer intento no existe: orq escala solo, sin que Opus declare el número
  const r3 = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'x' });
  assert.equal(r3.codigo, 4);
  assert.match(r3.salida, /implementador-sonnet/);
  assert.match(r3.salida, new RegExp(`worktree .*${ev.tarea}`));
  assert.equal(eventos(ctx).find((e) => e.tipo === 'escalamiento').tarea, ev.tarea);

  // estado muestra el worktree sin integrar y las delegaciones recientes
  let estado = orq(ctx, ['estado']);
  assert.equal(estado.codigo, 0, estado.error);
  assert.match(estado.salida, /Sensible: no/);
  assert.match(estado.salida, /sin integrar/);
  assert.match(estado.salida, new RegExp(`${ev2.id}.*aprobado`));

  // limpiar no toca lo no integrado
  assert.match(orq(ctx, ['limpiar']).salida, /0 limpiado\(s\); 1 sin integrar/);
  git(ctx, 'merge', '-q', '--no-ff', '-m', 'integrar', ev.rama);
  estado = orq(ctx, ['estado']);
  assert.match(estado.salida, /integrada \(orq limpiar\)/);
  const limpieza = orq(ctx, ['limpiar']);
  assert.equal(limpieza.codigo, 0, limpieza.error);
  assert.match(limpieza.salida, /1 limpiado/);
  assert.ok(!fs.existsSync(path.join(ctx.repo, ev.worktree)));
  assert.ok(!git(ctx, 'branch').includes('delegar/'));
});

test('--worktree solo acepta el worktree de una tarea: nunca el checkout principal', () => {
  const ctx = entorno();
  fs.writeFileSync(path.join(ctx.repo, 'borrador.txt'), 'trabajo a medias\n');
  for (const valor of ['.', ctx.repo, '..', 'no-existe']) {
    const r = orq(ctx, ['delegar', 'implementar', '--worktree', valor], { entrada: 'x' });
    assert.equal(r.codigo, 2, valor);
    assert.match(r.error, /No hay una tarea/);
  }
  assert.ok(!fs.existsSync(ctx.llamadas), 'no llegó a ejecutar Command Code');
  assert.equal(git(ctx, 'log', '--oneline').trim().split('\n').length, 1, 'main no recibió commits');
  assert.match(git(ctx, 'status', '--porcelain'), /\?\? borrador\.txt/);

  // con la ruta real del worktree de una tarea sí funciona, como alias de --continuar
  orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  const r = orq(ctx, ['delegar', 'implementar', '--worktree', ev.worktree], { entrada: 'y' });
  assert.equal(r.codigo, 0, r.error);
  assert.equal(delegaciones(ctx)[1].intento, 2);
});

test('rechazos: --intento, tarea de otro rol, modelo fuera de whitelist, prompt vacío, falla de cmd', () => {
  const ctx = entorno();
  const intento = orq(ctx, ['delegar', 'implementar', '--intento', '2'], { entrada: 'x' });
  assert.equal(intento.codigo, 2);
  assert.match(intento.error, /--continuar/);
  assert.equal(orq(ctx, ['delegar', 'implementar', '--modelo', 'z-ai/glm-5.3-flash'], { entrada: 'x' }).codigo, 3);
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: '  ' }).codigo, 2);
  assert.equal(orq(ctx, ['delegar', 'inventado'], { entrada: 'x' }).codigo, 2);
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'falla' });
  assert.equal(r.codigo, 1);
  assert.match(delegaciones(ctx)[0].alertas.join(' '), /terminó con código 1/);
  const otroRol = orq(ctx, ['delegar', 'tests', '--continuar', delegaciones(ctx)[0].tarea], { entrada: 'x' });
  assert.equal(otroRol.codigo, 2);
  assert.match(otroRol.error, /es del rol "implementar"/);
  assert.equal(orq(ctx, ['revision', 'no-existe', 'aprobado']).codigo, 2);
  assert.equal(orq(ctx, ['revision', 'x', 'quizas']).codigo, 2);
});

test('el timeout termina a Command Code y a los procesos que lanzó', () => {
  const ctx = entorno({ editarRegistro: (y) => y.replace('timeout_min: 30', 'timeout_min: 0.02') });
  const inicio = Date.now();
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'cuelga' });
  const segundos = (Date.now() - inicio) / 1000;
  assert.equal(r.codigo, 124, r.error);
  assert.ok(segundos < 15, `tardó ${segundos} s`);
  assert.ok(!procesoVivo('sleep 37.123'), 'quedó un proceso huérfano');
  assert.match(delegaciones(ctx)[0].alertas.join(' '), /timeout/);
});

test('un proceso que Command Code deja corriendo no cuelga a orq y se termina', () => {
  const ctx = entorno();
  const inicio = Date.now();
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'deja-proceso' });
  const segundos = (Date.now() - inicio) / 1000;
  assert.equal(r.codigo, 0, r.error);
  assert.ok(segundos < 15, `tardó ${segundos} s`);
  assert.ok(!procesoVivo('sleep 38.321'), 'quedó un proceso huérfano');
});

test('sandbox: Command Code no escribe fuera de su worktree ni modifica su .git', { skip: !MAC && 'solo macOS' }, () => {
  const ctx = entorno();
  for (const objetivo of [path.join(ctx.repo, 'escape.txt'), path.join(ctx.datos, 'escape.txt')]) {
    const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'escapa', env: { CMD_FALSO_OBJETIVO: objetivo } });
    assert.equal(r.codigo, 0, r.error + r.salida);
    assert.ok(!fs.existsSync(objetivo), objetivo);
  }

  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'toca-git' });
  assert.equal(r.codigo, 0, r.error + r.salida);
  const ev = delegaciones(ctx).at(-1);
  assert.match(fs.readFileSync(path.join(ctx.repo, ev.worktree, '.git'), 'utf8'), /^gitdir: .*\n$/);
  assert.deepEqual(ev.criticas, []);

  // rol de lectura: el sandbox no le deja escribir en el repo
  const lectura = orq(ctx, ['delegar', 'analizar'], { entrada: 'x', modo: 'escribe-sin-yolo' });
  assert.notEqual(lectura.codigo, 0);
  assert.ok(!fs.existsSync(path.join(ctx.repo, 'docs')));
});

test('sandbox: lectura_denegada impide leer otros repos pero no el actual ni lectura_extra (solo lectura)', { skip: !MAC && 'solo macOS' }, () => {
  const ctx = entorno({
    editarRegistro: (y, dir) => y
      .replace(/lectura_denegada: \[[^\]]*\]/, `lectura_denegada: ["${dir}"]`)
      .replace(/lectura_extra: \[[^\]]*\]/, `lectura_extra: ["${path.join(dir, 'referencias')}"]`),
  });
  const otro = path.join(ctx.dir, 'otro-repo');
  const refs = path.join(ctx.dir, 'referencias');
  fs.mkdirSync(otro);
  fs.mkdirSync(refs);
  fs.writeFileSync(path.join(otro, 'secreto.txt'), 'no deberías verme\n');
  fs.writeFileSync(path.join(refs, 'guia.txt'), 'referencia ok\n');
  // el repo actual (dentro de la carpeta denegada) sigue legible: delegar, commitear y git funcionan
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'lee-fuera', env: { CMD_FALSO_OBJETIVO: path.join(otro, 'secreto.txt') } });
  assert.equal(r.codigo, 0, r.error + r.salida);
  const [ev] = delegaciones(ctx);
  assert.equal(fs.readFileSync(path.join(ctx.repo, ev.worktree, 'docs', 'lectura.txt'), 'utf8'), 'bloqueado\n');
  assert.ok(ev.archivos.includes('docs/lectura.txt'));
  // lectura_extra se reabre solo para lectura (no escritura) y figura en estado
  const rRef = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'lee-fuera', env: { CMD_FALSO_OBJETIVO: path.join(refs, 'guia.txt') } });
  assert.equal(rRef.codigo, 0, rRef.error + rRef.salida);
  const evRef = delegaciones(ctx).at(-1);
  assert.equal(fs.readFileSync(path.join(ctx.repo, evRef.worktree, 'docs', 'lectura.txt'), 'utf8'), 'leido:referencia ok\n');
  orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'escapa', env: { CMD_FALSO_OBJETIVO: path.join(refs, 'escape.txt') } });
  assert.ok(!fs.existsSync(path.join(refs, 'escape.txt')), 'lectura_extra no permite escribir');
  assert.match(orq(ctx, ['estado']).salida, /lectura extra: .*referencias/);
  // sin la restricción, sí habría podido leerlo
  const libre = entorno();
  fs.writeFileSync(path.join(libre.dir, 'secreto.txt'), 'visible\n');
  orq(libre, ['delegar', 'implementar'], { entrada: 'x', modo: 'lee-fuera', env: { CMD_FALSO_OBJETIVO: path.join(libre.dir, 'secreto.txt') } });
  const [ev2] = delegaciones(libre);
  assert.equal(fs.readFileSync(path.join(libre.repo, ev2.worktree, 'docs', 'lectura.txt'), 'utf8'), 'leido:visible\n');
});

test('sandbox obligatorio sin sandbox disponible bloquea antes de crear el worktree', { skip: MAC && 'macOS tiene sandbox' }, () => {
  const ctx = entorno({ sandbox: 'obligatorio' });
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 3);
  assert.ok(!git(ctx, 'branch').includes('delegar/'));
});

test('integridad: si se toca la configuración de git no se commitea y sale con 5', () => {
  const ctx = entorno({ sandbox: 'desactivado' });
  const config = path.join(ctx.repo, '.git', 'config');
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'toca-config', env: { CMD_FALSO_OBJETIVO: config } });
  assert.equal(r.codigo, 5, r.error + r.salida);
  assert.match(r.salida, /⚠ INTEGRIDAD/);
  const [ev] = delegaciones(ctx);
  assert.match(ev.criticas.join(' '), /configuración de git/);
  assert.deepEqual(ev.archivos, []);
  assert.equal(git(ctx, 'rev-parse', ev.rama).trim(), git(ctx, 'rev-parse', 'main').trim(), 'la rama no recibió commits');
});

test('integridad: cambio de rama en el worktree, commits propios y escrituras en el checkout principal', () => {
  const ctx = entorno({ sandbox: 'desactivado' });
  const rama = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'cambia-rama' });
  assert.equal(rama.codigo, 5, rama.error + rama.salida);
  assert.match(delegaciones(ctx)[0].criticas.join(' '), /rama del worktree cambió a "otra-rama"/);

  const propio = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'commitea' });
  assert.equal(propio.codigo, 0, propio.error);
  const ev = delegaciones(ctx)[1];
  assert.match(ev.alertas.join(' '), /commits propios/);
  assert.equal(ev.archivos.length, 1, 'cuenta los archivos de sus commits');

  const objetivo = path.join(ctx.repo, 'escape.txt');
  const escape = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'escapa', env: { CMD_FALSO_OBJETIVO: objetivo } });
  assert.equal(escape.codigo, 0);
  assert.match(delegaciones(ctx)[2].alertas.join(' '), /Cambió el checkout principal.*escape\.txt/);
});

test('rol de lectura corre en la raíz sin --yolo y alerta si modifica el repo', () => {
  const ctx = entorno({ sandbox: 'desactivado' });
  assert.equal(orq(ctx, ['delegar', 'analizar'], { entrada: 'Resume.' }).codigo, 0);
  const [llamada] = llamadas(ctx);
  assert.ok(!llamada.args.includes('--yolo'));
  assert.equal(fs.realpathSync(llamada.cwd), fs.realpathSync(ctx.repo));
  assert.equal(delegaciones(ctx)[0].worktree, null);

  orq(ctx, ['delegar', 'analizar'], { entrada: 'x', modo: 'escribe-sin-yolo' });
  assert.match(delegaciones(ctx)[1].alertas.join(' '), /solo lectura pero cambió el repo/);

  // un archivo que ya tenía cambios tuyos: sin falsos positivos, pero detecta si Command Code lo vuelve
  // a cambiar (git status muestra la misma línea " M README.md" antes y después)
  fs.writeFileSync(path.join(ctx.repo, 'README.md'), '# editado por mí\n');
  orq(ctx, ['delegar', 'analizar'], { entrada: 'x' });
  assert.deepEqual(delegaciones(ctx)[2].alertas, []);
  orq(ctx, ['delegar', 'analizar'], { entrada: 'x', modo: 'solo-escribir', env: { CMD_FALSO_ESCRIBIR: 'README.md' } });
  assert.match(delegaciones(ctx)[3].alertas.join(' '), /solo lectura pero cambió el repo: archivos que ya tenían cambios/);
});

test('documentar alerta archivos fuera de docs/ y los diffs que tocan configuración', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'documentar'], { entrada: 'Documenta.', modo: 'escribe-fuera' });
  assert.match(delegaciones(ctx)[0].alertas.join(' '), /fuera de docs\/: src\/fuera\.js/);
  orq(ctx, ['delegar', 'implementar'], { entrada: 'x', env: { CMD_FALSO_ESCRIBIR: '.github/workflows/ci.yml' } });
  assert.match(delegaciones(ctx)[1].alertas.join(' '), /configuración de agentes, CI o git \(\.github\/workflows\/ci\.yml\)/);
});

test('preparar y validar corren en el worktree; su resultado queda en el resumen y en el log', () => {
  const ctx = entorno();
  ajustesRepo(ctx, [
    'preparar:',
    '  - echo listo > preparado.txt',
    'validar:',
    '  - ls docs',
    '  - mkdir -p coverage && echo x > coverage/out.txt',
    `  - 'echo "falló el test" >&2; exit 3'`,
    '',
  ].join('\n'));
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error + r.salida);
  const [ev] = delegaciones(ctx);
  const wt = path.join(ctx.repo, ev.worktree);
  assert.equal(ev.validacion.ok, false);
  assert.deepEqual(ev.validacion.comandos.map((c) => c.codigo), [0, 0, 3]);
  assert.match(r.salida, /validar: ✘ .*código 3/);
  assert.match(r.salida, /falló el test/);
  assert.match(r.salida, /preparar dejó 1 archivo/);
  assert.match(r.salida, /validar dejó cambios .*coverage\/out\.txt/);

  // lo de preparar se queda en el worktree pero no se commitea; lo de validar se descarta
  assert.ok(fs.existsSync(path.join(wt, 'preparado.txt')));
  assert.ok(!fs.existsSync(path.join(wt, 'coverage')));
  assert.doesNotMatch(git(ctx, 'show', '--name-only', '--format=', ev.rama), /preparado|coverage/);

  // al continuar la tarea, preparar no se repite y preparado.txt sigue fuera de los commits
  const r2 = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'y' });
  assert.equal(r2.codigo, 0, r2.error);
  const ev2 = delegaciones(ctx)[1];
  assert.ok(!fs.existsSync(path.join(ctx.datos, 'logs', 'salidas', `${ev2.id}.preparar.log`)));
  assert.doesNotMatch(git(ctx, 'diff', '--name-only', `${ev.base}..${ev.rama}`), /preparado/);

  // si preparar falla, no se delega y no queda worktree
  ajustesRepo(ctx, 'preparar:\n  - exit 7\n');
  const falla = orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  assert.equal(falla.codigo, 1);
  assert.match(falla.error, /Falló preparar: "exit 7" terminó con código 7/);
  assert.equal(git(ctx, 'branch', '--list', 'delegar/*tests*').trim(), '');
});

test('salida JSON: guarda tokens y a Opus solo le muestra la respuesta final', () => {
  const ctx = entorno({ editarRegistro: (y) => y.replace('salida_json: null', 'salida_json: true') });
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error);
  assert.ok(llamadas(ctx)[0].args.includes('--output-format'));
  assert.match(r.salida, /--- respuesta de Command Code ---\nArchivos modificados/);
  assert.doesNotMatch(r.salida, /"type":/);
  assert.match(r.salida, /tokens: entrada 1200 · salida 300/);
  const [ev] = delegaciones(ctx);
  assert.deepEqual(ev.uso, { entrada: 1200, salida: 300, razonamiento: null, cache: null, total: null, costo: null });
  assert.deepEqual(ev.herramientas, { write_file: 1 });
  assert.match(fs.readFileSync(ev.salida, 'utf8'), /"type":"result"/, 'el log guarda el stream crudo');
  const s = JSON.parse(orq(ctx, ['scorecard', '--json']).salida);
  assert.equal(s.totales.tokens, 1500);
  assert.equal(s.tareas[0].tokens_por_tarea, 1500);
});

test('revisión del intento exacto, ajustado y métricas por tarea en el scorecard', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  assert.equal(orq(ctx, ['revision', ev.tarea, 'corregido']).codigo, 0);
  orq(ctx, ['delegar', 'tests', '--continuar', ev.tarea], { entrada: 'y' });
  const ev2 = delegaciones(ctx)[1];
  assert.equal(orq(ctx, ['revision', ev2.id, 'ajustado', '--nota', 'import']).codigo, 0);
  // una revisión tardía del intento 1 (su id es también el de la tarea) no pisa la del intento 2
  const tardia = orq(ctx, ['revision', ev.id, 'corregido']);
  assert.match(tardia.salida, /intento 1 de la tarea.*\n.*ya tiene 1 intento\(s\) posterior/);
  const revisiones = eventos(ctx).filter((e) => e.tipo === 'revision');
  assert.deepEqual(revisiones.map((e) => [e.id, e.resultado]), [[ev.id, 'corregido'], [ev2.id, 'ajustado'], [ev.id, 'corregido']]);

  const s = JSON.parse(orq(ctx, ['scorecard', '--json']).salida);
  assert.equal(s.filas.reduce((n, f) => n + f.ajustadas, 0), 1);
  assert.equal(s.totales.ajustadas, 1);
  assert.deepEqual(
    (({ rol, tareas, resueltas_primer_intento, resueltas_con_reintento, escaladas, abiertas }) =>
      ({ rol, tareas, resueltas_primer_intento, resueltas_con_reintento, escaladas, abiertas }))(s.tareas[0]),
    { rol: 'tests', tareas: 1, resueltas_primer_intento: 0, resueltas_con_reintento: 1, escaladas: 0, abiertas: 0 },
  );
  assert.match(orq(ctx, ['scorecard']).salida, /Por tarea/);
});

test('estado: roles, whitelist, tareas abiertas y aviso de tarea repetida para una fase', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests', '--fase', 'Fase 3'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  orq(ctx, ['revision', ev.id, 'corregido']);
  const estado = orq(ctx, ['estado']).salida;
  assert.match(estado, /Cuándo usar cada rol:\n {2}explorar/);
  assert.match(estado, /Whitelist de modelos delegables:\n {2}deepseek\/deepseek-v4\.1-flash-fast \(activo, Command Code\)/);
  assert.match(estado, /Modelos por rol .*\n {2}explorar {5}deepseek\/deepseek-v4\.1-flash-fast, antigravity\/gemini-4-neon/);
  assert.match(estado, /Antigravity: tu cuenta personal de Google · skills no/);
  assert.match(estado, /Sandbox: .*lectura denegada: .*\/dev/);
  assert.match(estado, /Nunca se delegan: Plan y diseño/);
  assert.match(estado, new RegExp(`Tareas abiertas en este repo:\n {2}${ev.tarea} {2}tests · Fase 3 · intento 1/2 · corregido .*--continuar ${ev.tarea}`));
  if (MAC) assert.match(estado, /Sandbox: sandbox-exec \(modo auto\)/);

  const otra = orq(ctx, ['delegar', 'tests', '--fase', 'Fase 3'], { entrada: 'x' });
  assert.match(otra.salida, new RegExp(`Ya había 1 tarea\\(s\\) abierta\\(s\\).*--continuar ${ev.tarea}`));
});

test('desde dentro de un worktree de delegación, orq trabaja sobre el checkout principal', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  const r = orq(ctx, ['delegar', 'tests'], { entrada: 'x', cwd: path.join(ctx.repo, ev.worktree) });
  assert.equal(r.codigo, 0, r.error);
  const ev2 = delegaciones(ctx)[1];
  assert.equal(ev2.raiz, fs.realpathSync(ctx.repo));
  assert.match(ev2.worktree, /^\.claude\/worktrees\/[^/]+$/);
});

test('worktrees en una carpeta externa', () => {
  const ctx = entorno({
    editarRegistro: (y, dir) => y.replace('ubicacion: repo', 'ubicacion: externa')
      .replace('dir_externo: ~/.orquestador/worktrees', `dir_externo: ${path.join(dir, 'wts')}`),
  });
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error + r.salida);
  const [ev] = delegaciones(ctx);
  const ruta = path.resolve(ctx.repo, ev.worktree);
  assert.ok(ruta.startsWith(path.join(ctx.dir, 'wts', 'repo-')), ruta);
  assert.ok(fs.existsSync(path.join(ruta, 'docs')));
  assert.ok(!fs.existsSync(path.join(ctx.repo, '.claude', 'worktrees')));
  assert.equal(orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'y' }).codigo, 0);
  assert.match(orq(ctx, ['estado']).salida, /delegar\/.*sin integrar/);
  assert.equal(orq(ctx, ['limpiar', '--descartar', ev.tarea]).codigo, 0);
  assert.ok(!fs.existsSync(ruta));
});

test('limpiar --descartar elimina una delegación sin integrar', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  assert.match(orq(ctx, ['limpiar', '--descartar', ev.id, '--simular']).salida, /Se eliminaría sin integrar/);
  assert.ok(fs.existsSync(path.join(ctx.repo, ev.worktree)));
  assert.equal(orq(ctx, ['limpiar', '--descartar', ev.id]).codigo, 0);
  assert.ok(!fs.existsSync(path.join(ctx.repo, ev.worktree)));
  assert.equal(orq(ctx, ['limpiar', '--descartar', 'no-existe']).codigo, 2);
  // con el worktree eliminado, la tarea ya no se puede continuar
  const r = orq(ctx, ['delegar', 'tests', '--continuar', ev.tarea], { entrada: 'x' });
  assert.equal(r.codigo, 2);
  assert.match(r.error, /ya no existe/);
});

test('orq init --sensible bloquea Command Code en el repo con el motivo', () => {
  const ctx = entorno();
  const init = orq(ctx, ['init', '--sensible']);
  assert.equal(init.codigo, 0, init.error);
  assert.match(init.salida, /Repo sensible/);
  assert.equal(orq(ctx, ['init']).codigo, 2);

  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 3);
  assert.match(r.error, /Motivo: .*sensible: true/);
  assert.ok(!fs.existsSync(ctx.llamadas));
  assert.match(orq(ctx, ['estado']).salida, /Sensible: SÍ/);
});

test('desactivado: true bloquea delegar y estado lo dice', () => {
  const ctx = entorno();
  ajustesRepo(ctx, 'desactivado: true\n');
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 3);
  assert.match(r.error, /desactivado/);
  assert.ok(!fs.existsSync(ctx.llamadas));
  assert.match(orq(ctx, ['estado']).salida, /DESACTIVADO/);
});

test('los patrones globales detectan repos sensibles por remoto', () => {
  const ctx = entorno({ editarRegistro: (y) => y.replace('remotos: []', 'remotos: ["*privado*"]') });
  git(ctx, 'remote', 'add', 'origin', 'git@github.com:alguien/privado.git');
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 3);
  assert.match(r.error, /el remoto .*privado/);
});

test('los ajustes del repo cambian effort y límites; claves globales se rechazan', () => {
  const ctx = entorno();
  ajustesRepo(ctx, 'roles:\n  tests:\n    effort: high\n    effort_reintento: max\n');
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'x' }).codigo, 0);
  assert.equal(llamadas(ctx)[0].args[4], 'high');
  assert.match(orq(ctx, ['estado']).salida, /roles ajustados: tests/);

  ajustesRepo(ctx, 'models:\n  x/y: {}\n');
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'x' }).codigo, 2);
});

test('un YAML mal formado da un mensaje claro, sin stack trace', () => {
  const ctx = entorno();
  ajustesRepo(ctx, 'roles: [\n');
  const r = orq(ctx, ['estado']);
  assert.equal(r.codigo, 2);
  assert.match(r.error, /orquestador\.yaml no es YAML válido/);
  assert.doesNotMatch(r.error, /\n\s+at /);
  fs.writeFileSync(ctx.registro, 'models: {\n');
  assert.match(orq(ctx, ['doctor']).salida, /models\.yaml no es YAML válido/);
});

test('skills: se pasan con --skill solo si son compatibles', () => {
  const ctx = entorno({ editarRegistro: (y) => y.replace('skills_compatibles: null', 'skills_compatibles: true') });
  fs.mkdirSync(path.join(ctx.repo, '.claude', 'skills', 'estilo'), { recursive: true });
  ajustesRepo(ctx, 'roles:\n  implementar:\n    skills: [.claude/skills/estilo]\n');
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'x' }).codigo, 0);
  const args = llamadas(ctx)[0].args;
  assert.equal(args[args.indexOf('--skill') + 1], path.join(fs.realpathSync(ctx.repo), '.claude', 'skills', 'estilo'));

  const ctx2 = entorno();
  fs.mkdirSync(path.join(ctx2.repo, '.claude', 'skills', 'estilo'), { recursive: true });
  ajustesRepo(ctx2, 'roles:\n  implementar:\n    skills: [.claude/skills/estilo]\n');
  const r = orq(ctx2, ['delegar', 'implementar'], { entrada: 'x' });
  assert.ok(!llamadas(ctx2)[0].args.includes('--skill'));
  assert.match(r.salida, /resume sus reglas dentro del prompt/);
});

test('verificar --guardar prueba skills, salida JSON y sandbox, y lo guarda en el registro', () => {
  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  const r = orq(ctx, ['verificar', '--guardar']);
  assert.equal(r.codigo, 0, r.salida + r.error);
  const yaml = fs.readFileSync(ctx.registro, 'utf8');
  assert.match(yaml, /skills_compatibles: true/);
  assert.match(yaml, /salida_json: true/);
  assert.match(yaml, /# Registro global del orquestador/);
  if (MAC) {
    assert.match(r.salida, /✔ Sandbox sandbox-exec: bloquea escrituras fuera del worktree/);
    assert.match(r.salida, /✔ .*funciona dentro del sandbox/);
    assert.match(r.salida, /✔ .*el sandbox bloquea sus escrituras fuera del worktree/);
  }
  for (const dir of [path.join(ctx.datos, 'logs'), ctx.home]) {
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.orq-verificar-')), [], `restos en ${dir}`);
  }
});

test('scorecard agrega todos los repos; --aqui distingue repos con el mismo nombre', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  const otro = path.join(ctx.dir, 'otra-carpeta', 'repo');
  fs.mkdirSync(otro, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: otro });
  orq(ctx, ['delegar', 'analizar'], { entrada: 'x', cwd: otro });
  const todo = JSON.parse(orq(ctx, ['scorecard', '--json']).salida);
  assert.equal(todo.filas.length, 2);
  const aqui = JSON.parse(orq(ctx, ['scorecard', '--json', '--aqui']).salida);
  assert.deepEqual(aqui.filas.map((f) => f.rol), ['tests']);
  const porNombre = JSON.parse(orq(ctx, ['scorecard', '--json', '--repo', 'repo']).salida);
  assert.equal(porNombre.filas.length, 2);
});

test('doctor reporta el estado del registro, el sandbox y el repo', () => {
  const ctx = entorno();
  const r = orq(ctx, ['doctor']);
  assert.match(r.salida, /✔ Registro válido/);
  assert.match(r.salida, /✔ Command Code 1\.84\.0/);
  assert.match(r.salida, /Fase 0 pendiente/);
  assert.match(r.salida, /✔ Skill orquestar instalada/);
  if (MAC) assert.match(r.salida, /✔ Sandbox sandbox-exec/);
  assert.match(r.salida, /Repo actual:/);
  fs.mkdirSync(path.join(ctx.repo, '.claude', 'orquestador', 'bin'), { recursive: true });
  assert.match(orq(ctx, ['doctor']).salida, /instalación por repo de la versión 0\.1/);
});
