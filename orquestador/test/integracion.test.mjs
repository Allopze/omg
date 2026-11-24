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
  assert.deepEqual(llamada.args, [
    '-p', '--model', 'deepseek/deepseek-v4.1-flash-fast', '--effort', 'high', '--yolo', '--output-format', 'json', '--skip-onboarding',
  ]);
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

  // tarea ya resuelta: --continuar la rechaza salvo con --reabrir; el tercer intento escala solo
  const r3Cerrada = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'x' });
  assert.equal(r3Cerrada.codigo, 2);
  assert.match(r3Cerrada.error, /ya está cerrada \(estado: resuelta\).*--reabrir/);
  const r3 = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea, '--reabrir'], { entrada: 'x' });
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
  // con la tarea descartada, --continuar se rechaza salvo --reabrir (que luego detecta el worktree ausente)
  const r = orq(ctx, ['delegar', 'tests', '--continuar', ev.tarea], { entrada: 'x' });
  assert.equal(r.codigo, 2);
  assert.match(r.error, /ya está cerrada \(estado: descartada\)/);
  const rReabrir = orq(ctx, ['delegar', 'tests', '--continuar', ev.tarea, '--reabrir'], { entrada: 'x' });
  assert.equal(rReabrir.codigo, 2);
  assert.match(rReabrir.error, /ya no existe/);
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

test('salida_json: false explícito desactiva --output-format json y entrega texto plano', () => {
  const ctx = entorno({ editarRegistro: (y) => y.replace('salida_json: null', 'salida_json: false') });
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error + r.salida);
  const [llamada] = llamadas(ctx);
  assert.ok(!llamada.args.includes('--output-format'));
  assert.equal(delegaciones(ctx)[0].uso, null);
  assert.match(r.salida, /Archivos modificados: docs\/cambio\.md/);
  assert.doesNotMatch(r.salida, /--- respuesta de Command Code ---/);
  assert.match(orq(ctx, ['estado']).salida, /salida JSON no/);
});

test('--continuar rechaza tareas resueltas, escaladas y descartadas salvo con --reabrir', () => {
  const ctx = entorno();
  // 1. resuelta
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'x' }).codigo, 0);
  const t1 = delegaciones(ctx)[0];
  assert.equal(orq(ctx, ['revision', t1.id, 'aprobado']).codigo, 0);
  const cRes = orq(ctx, ['delegar', 'tests', '--continuar', t1.tarea], { entrada: 'y' });
  assert.equal(cRes.codigo, 2);
  assert.match(cRes.error, /ya está cerrada \(estado: resuelta\)/);
  const rRes = orq(ctx, ['delegar', 'tests', '--continuar', t1.tarea, '--reabrir'], { entrada: 'y' });
  assert.equal(rRes.codigo, 0, rRes.error);
  assert.equal(delegaciones(ctx).at(-1).intento, 2);

  // 2. escalada
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'a' }).codigo, 0);
  const t2 = delegaciones(ctx).at(-1);
  assert.equal(orq(ctx, ['delegar', 'tests', '--continuar', t2.tarea], { entrada: 'b' }).codigo, 0);
  assert.equal(orq(ctx, ['delegar', 'tests', '--continuar', t2.tarea], { entrada: 'c' }).codigo, 4);
  const cEsc = orq(ctx, ['delegar', 'tests', '--continuar', t2.tarea], { entrada: 'd' });
  assert.equal(cEsc.codigo, 2);
  assert.match(cEsc.error, /ya está cerrada \(estado: escalada\)/);
  const rEsc = orq(ctx, ['delegar', 'tests', '--continuar', t2.tarea, '--reabrir'], { entrada: 'd' });
  assert.equal(rEsc.codigo, 4);

  // 3. descartada
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'p' }).codigo, 0);
  const t3 = delegaciones(ctx).at(-1);
  assert.equal(orq(ctx, ['limpiar', '--descartar', t3.tarea]).codigo, 0);
  const cDesc = orq(ctx, ['delegar', 'tests', '--continuar', t3.tarea], { entrada: 'q' });
  assert.equal(cDesc.codigo, 2);
  assert.match(cDesc.error, /ya está cerrada \(estado: descartada\)/);
});

test('--continuar sin <rol> ni --modelo hereda rol y modelo y avisa si el previo se retiró', () => {
  const ctx = entorno({ editarRegistro: permitirCuentaPersonal });
  assert.equal(orq(ctx, ['delegar', 'implementar', '--modelo', 'antigravity/gemini-4-neon'], { entrada: 'x' }).codigo, 0);
  const [ev1] = delegaciones(ctx);

  const r2 = orq(ctx, ['delegar', '--continuar', ev1.tarea], { entrada: 'y' });
  assert.equal(r2.codigo, 0, r2.error + r2.salida);
  const ev2 = delegaciones(ctx)[1];
  assert.equal(ev2.rol, 'implementar');
  assert.equal(ev2.modelo, 'antigravity/gemini-4-neon');
  assert.equal(ev2.intento, 2);

  // También funciona con --worktree omitiendo <rol> y si el modelo anterior se retira cae al primario con aviso
  const yaml = fs.readFileSync(ctx.registro, 'utf8');
  fs.writeFileSync(
    ctx.registro,
    yaml.replace(/(antigravity\/gemini-4-neon:[\s\S]*?estado: )en_prueba/, '$1retirado').replace('max_intentos: 2', 'max_intentos: 3'),
  );
  // Ajustar max_intentos en implementar específicamente (el primer max_intentos: 2 es de explorar)
  const yaml2 = fs.readFileSync(ctx.registro, 'utf8')
    .replace(/(implementar:[\s\S]*?max_intentos: )2/, '$13');
  fs.writeFileSync(ctx.registro, yaml2);
  const r3 = orq(ctx, ['delegar', '--worktree', ev1.worktree], { entrada: 'z' });
  assert.equal(r3.codigo, 0, r3.error + r3.salida);
  const ev3 = delegaciones(ctx)[2];
  assert.equal(ev3.rol, 'implementar');
  assert.equal(ev3.modelo, 'deepseek/deepseek-v4.1-flash-fast');
  assert.match(r3.salida, /aviso: El intento anterior usó "antigravity\/gemini-4-neon", que ya no está disponible/);
});

test('--prompt-archivo válido, faltante y vacío; y --dry-run completo', () => {
  const ctx = entorno();
  const archivo = path.join(ctx.tmp, 'mi-prompt.md');
  fs.writeFileSync(archivo, 'Implementa desde archivo.\n');

  const dry = orq(ctx, ['delegar', 'implementar', '--prompt-archivo', archivo, '--dry-run']);
  assert.equal(dry.codigo, 0, dry.error + dry.salida);
  assert.match(dry.salida, /"ejecutor": "command_code"/);
  assert.match(dry.salida, /Implementa desde archivo\./);
  assert.ok(!fs.existsSync(ctx.llamadas));

  const ok = orq(ctx, ['delegar', 'implementar', '--prompt-archivo', archivo]);
  assert.equal(ok.codigo, 0, ok.error);
  assert.match(llamadas(ctx)[0].entrada, /Implementa desde archivo\./);

  const falta = orq(ctx, ['delegar', 'implementar', '--prompt-archivo', path.join(ctx.tmp, 'no-existe.md')]);
  assert.equal(falta.codigo, 2);
  assert.match(falta.error, /No se pudo leer --prompt-archivo/);
  assert.doesNotMatch(falta.error, /\n\s+at /);

  const vacio = orq(ctx, ['delegar', 'implementar', '--prompt-archivo', '']);
  assert.equal(vacio.codigo, 2);
  assert.match(vacio.error, /Indica la ruta del archivo/);
});

test('orq verificar --capacidades --guardar guarda capacidades rápido y rechaza --guardar --sin-llamadas', () => {
  const ctx = entorno();
  const inv1 = orq(ctx, ['verificar', '--guardar', '--sin-llamadas']);
  assert.equal(inv1.codigo, 2);
  assert.match(inv1.error, /--guardar.*--sin-llamadas/);
  assert.equal(orq(ctx, ['verificar', '--capacidades', '--sin-llamadas']).codigo, 2);
  assert.equal(orq(ctx, ['verificar', '--capacidades', '--ejecutor', 'antigravity']).codigo, 2);

  const r = orq(ctx, ['verificar', '--capacidades', '--guardar'], { env: { ORQ_AGY_BIN: '/no/existe' } });
  assert.equal(r.codigo, 0, r.salida + r.error);
  assert.equal(llamadas(ctx).length, 2, 'solo prueba --skill y --output-format json en el modelo principal');
  assert.doesNotMatch(r.salida, /Sandbox sandbox-exec/);
  const yaml = fs.readFileSync(ctx.registro, 'utf8');
  assert.match(yaml, /skills_compatibles: true/);
  assert.match(yaml, /salida_json: true/);
  assert.match(yaml, /# Registro global del orquestador/);
});

test('orq limpiar: excluidos de preparar, squash merge, --resueltas, carpeta eliminada, solo lectura y --logs', () => {
  const ctx = entorno();

  // 1. Archivos dejados por preparar (wt.excluir) no bloquean limpiar tras merge; archivo sucio extra sí bloquea
  ajustesRepo(ctx, 'preparar:\n  - echo secreto=1 > .env.local\n');
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'x' }).codigo, 0);
  const [evPrep] = delegaciones(ctx);
  git(ctx, 'merge', '-q', '--no-ff', '-m', 'merge prep', evPrep.rama);
  fs.writeFileSync(path.join(ctx.repo, evPrep.worktree, 'sucio.txt'), 'sin commit\n');
  const sucio = orq(ctx, ['limpiar']);
  assert.equal(sucio.codigo, 1);
  assert.match(sucio.error, /tiene cambios sin commit/);
  fs.rmSync(path.join(ctx.repo, evPrep.worktree, 'sucio.txt'));
  assert.equal(orq(ctx, ['limpiar']).codigo, 0);
  assert.ok(!fs.existsSync(path.join(ctx.repo, evPrep.worktree)));

  // 2. Clean squash merge se detecta automáticamente
  ajustesRepo(ctx, 'preparar: []\n');
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'squash' }).codigo, 0);
  const evSq = delegaciones(ctx).at(-1);
  git(ctx, 'merge', '--squash', '-q', evSq.rama);
  git(ctx, 'commit', '-q', '-m', 'squash merge');
  assert.match(orq(ctx, ['estado']).salida, /integrada \(orq limpiar\)/);
  assert.match(orq(ctx, ['limpiar']).salida, /1 limpiado\(s\)/);

  // 3. Squash con cambios divergentes posteriores requiere --resueltas (tras aprobar)
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'div' }).codigo, 0);
  const evRes = delegaciones(ctx).at(-1);
  assert.equal(orq(ctx, ['revision', evRes.id, 'aprobado']).codigo, 0);
  git(ctx, 'merge', '--squash', '-q', evRes.rama);
  fs.writeFileSync(path.join(ctx.repo, evRes.archivos[0]), '# editado en main tras squash\n');
  git(ctx, 'add', '-A');
  git(ctx, 'commit', '-q', '-m', 'squash modificado');
  assert.match(orq(ctx, ['limpiar']).salida, /0 limpiado\(s\); 1 sin integrar/);
  assert.match(orq(ctx, ['limpiar', '--resueltas']).salida, /1 limpiado\(s\)/);
  assert.ok(!git(ctx, 'branch', '--list', `delegar/${evRes.tarea}`).trim());

  // 4. Carpeta del worktree borrada manualmente + --descartar
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'borrada' }).codigo, 0);
  const evBorrada = delegaciones(ctx).at(-1);
  fs.rmSync(path.join(ctx.repo, evBorrada.worktree), { recursive: true, force: true });
  assert.match(orq(ctx, ['estado']).salida, /carpeta eliminada/);
  const descBorrada = orq(ctx, ['limpiar', '--descartar', evBorrada.tarea]);
  assert.equal(descBorrada.codigo, 0, descBorrada.error);
  assert.equal(git(ctx, 'branch', '--list', `delegar/${evBorrada.tarea}`).trim(), '');

  // 5. Tarea de solo lectura + --descartar + --logs (conserva tareas abiertas)
  assert.equal(orq(ctx, ['delegar', 'analizar'], { entrada: 'lectura' }).codigo, 0);
  const evLect = delegaciones(ctx).at(-1);
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'abierta' }).codigo, 0);
  const evAbierta = delegaciones(ctx).at(-1);
  const descLect = orq(ctx, ['limpiar', '--descartar', evLect.tarea, '--logs']);
  assert.equal(descLect.codigo, 0, descLect.error);
  assert.match(descLect.salida, /solo lectura/);
  assert.match(descLect.salida, /Logs podados:/);
  assert.doesNotMatch(orq(ctx, ['estado']).salida, /Tareas abiertas de solo lectura/);
  assert.equal(JSON.parse(orq(ctx, ['estado', '--json']).salida).tareas_abiertas_lectura.length, 0);
  assert.ok(fs.existsSync(path.join(ctx.datos, 'logs', 'salidas', `${evAbierta.id}.log`)), 'conserva logs de tarea abierta');
  assert.ok(!fs.existsSync(path.join(ctx.datos, 'logs', 'salidas', `${evLect.id}.log`)), 'poda logs de tarea cerrada');
});

test('orq <cmd> --help, orq ayuda <cmd> y errores localizados de parseArgs', () => {
  const ctx = entorno();
  const cmds = ['delegar', 'revision', 'validar', 'ver', 'estado', 'init', 'limpiar', 'scorecard', 'verificar', 'doctor'];
  for (const c of cmds) {
    const h1 = orq(ctx, [c, '--help']);
    assert.equal(h1.codigo, 0, `${c} --help: ${h1.error}`);
    assert.match(h1.salida, new RegExp(`Uso: orq ${c}`));

    const h2 = orq(ctx, ['ayuda', c]);
    assert.equal(h2.codigo, 0, `ayuda ${c}: ${h2.error}`);
    assert.match(h2.salida, new RegExp(`Uso: orq ${c}`));
  }
  assert.equal(orq(ctx, ['ayuda', 'inventado']).codigo, 2);

  const errDesc = orq(ctx, ['estado', '--inventada']);
  assert.equal(errDesc.codigo, 2);
  assert.match(errDesc.error, /Opción desconocida: --inventada\. Usa: orq estado --help/);

  const errFalta = orq(ctx, ['delegar', 'implementar', '--modelo']);
  assert.equal(errFalta.codigo, 2);
  assert.match(errFalta.error, /Falta el valor de la opción --modelo\. Usa: orq delegar --help/);

  const errBool = orq(ctx, ['estado', '--resumen=1']);
  assert.equal(errBool.codigo, 2);
  assert.match(errBool.error, /La opción --resumen no admite valor\. Usa: orq estado --help/);

  const errPos = orq(ctx, ['doctor', 'extra']);
  assert.equal(errPos.codigo, 2);
  assert.match(errPos.error, /Argumento inesperado "extra": este comando no recibe argumentos posicionales\. Usa: orq doctor --help/);
});

test('orq ver <tarea> con tabla de intentos, --prompt, --log y --json', () => {
  const ctx = entorno();
  assert.equal(orq(ctx, ['delegar', 'implementar', '--fase', 'Fase 2'], { entrada: 'Prompt uno.' }).codigo, 0);
  const [ev1] = delegaciones(ctx);
  assert.equal(orq(ctx, ['revision', ev1.id, 'corregido', '--nota', 'falta borde']).codigo, 0);
  assert.equal(orq(ctx, ['delegar', '--continuar', ev1.tarea], { entrada: 'Prompt dos.' }).codigo, 0);
  const ev2 = delegaciones(ctx)[1];

  const ver = orq(ctx, ['ver', ev1.tarea, '--prompt', '--log']);
  assert.equal(ver.codigo, 0, ver.error);
  assert.match(ver.salida, new RegExp(`Tarea: ${ev1.tarea} · estado: abierta · rol: implementar · fase: Fase 2`));
  assert.match(ver.salida, /Notas de revisión:\n {2}intento 1 \(corregido\): falta borde/);
  assert.match(ver.salida, /Diff: git diff /);
  assert.match(ver.salida, new RegExp(`--- prompt \\(${ev2.id}\\) ---[\\s\\S]*Prompt dos\\.`));
  assert.match(ver.salida, new RegExp(`--- últimas 40 líneas de salida \\(${ev2.id}\\) ---`));

  const json = JSON.parse(orq(ctx, ['ver', ev1.tarea, '--json', '--prompt', '--log']).salida);
  assert.equal(json.tarea, ev1.tarea);
  assert.equal(json.intento_consultado, ev2.id);
  assert.equal(json.intentos.length, 2);
  assert.equal(json.intentos[0].revision.nota, 'falta borde');
  assert.match(json.prompt_texto, /Prompt dos\./);
  assert.ok(Array.isArray(json.log_cola) && json.log_cola.length > 0);
  assert.equal(orq(ctx, ['ver', 'no-existe']).codigo, 2);
});

test('orq init --sensible actualiza sin destruir ajustes y detecta sensibilidad global y .gitignore', () => {
  const ctx = entorno();
  ajustesRepo(ctx, [
    'sensible: false # comentario',
    'preparar:',
    '  - echo prep',
    'validar:',
    '  - echo val',
    'roles:',
    '  tests:',
    '    effort: high',
    '',
  ].join('\n'));
  const upd = orq(ctx, ['init', '--sensible']);
  assert.equal(upd.codigo, 0, upd.error);
  assert.match(upd.salida, /Actualizado \.claude\/orquestador\.yaml \(sensible: true; se conservan los demás ajustes\)/);
  const contenido = fs.readFileSync(path.join(ctx.repo, '.claude', 'orquestador.yaml'), 'utf8');
  assert.match(contenido, /^sensible: true # comentario$/m);
  assert.match(contenido, /echo prep/);
  assert.match(contenido, /effort: high/);

  const ctxGlobal = entorno({ editarRegistro: (y) => y.replace('remotos: []', 'remotos: ["*privado*"]') });
  git(ctxGlobal, 'remote', 'add', 'origin', 'git@github.com:org/privado.git');
  fs.writeFileSync(path.join(ctxGlobal.repo, '.gitignore'), '.claude/orquestador.yaml\n');
  const ig = orq(ctxGlobal, ['init']);
  assert.equal(ig.codigo, 0, ig.error);
  assert.match(ig.salida, /inicializado con sensible: true/);
  assert.match(ig.salida, /Aviso: \.claude\/orquestador\.yaml está ignorado por git/);
  assert.doesNotMatch(ig.salida, /git add \.claude\/orquestador\.yaml/);
});

test('orq estado --resumen --json, tareas de lectura separadas y desactivado: true mantiene worktrees', () => {
  const ctx = entorno();
  assert.equal(orq(ctx, ['delegar', 'tests'], { entrada: 'w' }).codigo, 0);
  assert.equal(orq(ctx, ['delegar', 'analizar'], { entrada: 'r' }).codigo, 0);
  const [evW, evR] = delegaciones(ctx);

  const completo = orq(ctx, ['estado']);
  assert.match(completo.salida, new RegExp(`Tareas abiertas en este repo:[\\s\\S]*${evW.tarea}`));
  assert.match(completo.salida, new RegExp(`Tareas abiertas de solo lectura:[\\s\\S]*${evR.tarea}`));

  const res = orq(ctx, ['estado', '--resumen']);
  assert.equal(res.codigo, 0, res.error);
  assert.doesNotMatch(res.salida, /Roles \(valores efectivos/);
  assert.doesNotMatch(res.salida, /Whitelist de modelos delegables/);
  assert.doesNotMatch(res.salida, /Nunca se delegan:/);
  assert.match(res.salida, /Worktrees de delegación: 1/);

  const jsonRes = JSON.parse(orq(ctx, ['estado', '--resumen', '--json']).salida);
  assert.equal(jsonRes.worktrees.length, 1);
  assert.equal(jsonRes.tareas_abiertas.length, 1);
  assert.equal(jsonRes.tareas_abiertas_lectura.length, 1);
  assert.equal(jsonRes.roles, undefined);
  assert.equal(jsonRes.models, undefined);

  ajustesRepo(ctx, 'desactivado: true\n');
  const des = orq(ctx, ['estado']);
  assert.equal(des.codigo, 0);
  assert.match(des.salida, /DESACTIVADO/);
  assert.match(des.salida, /Worktrees de delegación: 1/);
  assert.match(des.salida, new RegExp(`Tareas abiertas en este repo:[\\s\\S]*${evW.tarea}`));
  const desJson = JSON.parse(orq(ctx, ['estado', '--json']).salida);
  assert.equal(desJson.repo.desactivado, true);
  assert.equal(desJson.worktrees.length, 1);
});

test('revision avisa al aprobar fallos o reemplazar revisión; scorecard valida fechas, --detalle y --repo', () => {
  const ctx = entorno();
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'falla' }).codigo, 1);
  const [ev] = delegaciones(ctx);

  const apr = orq(ctx, ['revision', ev.id, 'aprobado']);
  assert.equal(apr.codigo, 0);
  assert.match(apr.salida, /Aviso: estás marcando como aprobado un intento con exit_code 1/);

  const rep = orq(ctx, ['revision', ev.id, 'corregido']);
  assert.equal(rep.codigo, 0);
  assert.match(rep.salida, /ya tenía una revisión previa \(aprobado\); esta nueva revisión la reemplaza/);

  assert.equal(orq(ctx, ['scorecard', '--desde', '2026-13-01']).codigo, 2);
  const otroRepo = orq(ctx, ['scorecard', '--repo', 'inexistente']);
  assert.equal(otroRepo.codigo, 0);
  assert.match(otroRepo.salida, /Repos con delegaciones registradas: repo/);

  assert.match(orq(ctx, ['scorecard']).salida, /min delegados/);
  const det = orq(ctx, ['scorecard', '--detalle']);
  assert.match(det.salida, /1er intento/);
  assert.match(det.salida, /Críticas/);
});
