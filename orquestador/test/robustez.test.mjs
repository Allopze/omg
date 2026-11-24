// Casos de la revisión final: códigos de salida, repos anidados, entorno sin secretos, temporales de
// Claude Code, worktrees sin commits, tareas descartadas, --dry-run, orq validar y robustez ante errores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  MAC, ORQ, entorno, entornoOrq, orq, eventos, delegaciones, git, ajustesRepo, procesoVivo,
} from './ayuda.mjs';

const esperar = async (condicion, ms = 15000) => {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('si orq recibe SIGTERM mientras corre el ejecutor, el intento queda registrado y el ejecutor termina', async () => {
  const ctx = entorno();
  const hijo = spawn(process.execPath, [ORQ, 'delegar', 'implementar'], {
    cwd: ctx.repo, env: entornoOrq(ctx, { modo: 'cuelga' }), stdio: ['pipe', 'ignore', 'ignore'],
  });
  hijo.stdin.end('x');
  await esperar(() => fs.existsSync(ctx.llamadas));
  hijo.kill('SIGTERM');
  const codigo = await new Promise((r) => hijo.on('exit', r));
  assert.equal(codigo, 143);
  const [ev] = delegaciones(ctx);
  assert.equal(ev.interrumpida, 'SIGTERM');
  assert.equal(ev.exit_code, 1);
  assert.match(ev.alertas.join(' '), /orq se interrumpió \(SIGTERM\)/);
  await esperar(() => !procesoVivo('sleep 37.123'), 5000);
});

test('un código propio del ejecutor (p. ej. 5 = rate limit) sale como 1, no como "integridad"', () => {
  const ctx = entorno();
  for (const codigo of ['3', '4', '5', '8']) {
    const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'sale-con', env: { CMD_FALSO_CODIGO: codigo } });
    assert.equal(r.codigo, 1, `cmd salió con ${codigo}`);
    const ev = delegaciones(ctx).at(-1);
    assert.equal(ev.codigo_ejecutor, Number(codigo));
    assert.equal(ev.exit_code, 1);
    assert.deepEqual(ev.criticas, []);
    assert.match(ev.alertas.join(' '), new RegExp(`terminó con código ${codigo}`));
  }
});

test('un repo git anidado no se commitea y sale como integridad (podría ejecutar filtros fuera del sandbox)', () => {
  for (const sandbox of [undefined, 'desactivado']) {
    const ctx = entorno({ sandbox });
    const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'repo-anidado' });
    assert.equal(r.codigo, 5, r.error + r.salida);
    const [ev] = delegaciones(ctx);
    assert.match(ev.criticas.join(' '), /repo git anidado en el worktree \(sub\/\)/);
    assert.doesNotMatch(git(ctx, 'ls-tree', '-r', '--name-only', ev.rama), /^sub/m, 'no hay gitlink de sub en la rama');
    assert.ok(ev.archivos.length >= 1, 'el resto de los cambios sí se commitea');
  }
});

test('el modelo delegado recibe un entorno sin secretos y un TMPDIR propio', () => {
  const ctx = entorno();
  const r = orq(ctx, ['delegar', 'implementar'], {
    entrada: 'x', modo: 'entorno', env: { SSH_AUTH_SOCK: '/tmp/agente.sock', GH_TOKEN: 'ghp_x', AWS_REGION: 'us-east-1', MI_API_KEY: 'k' },
  });
  assert.equal(r.codigo, 0, r.error + r.salida);
  const [ev] = delegaciones(ctx);
  const env = JSON.parse(git(ctx, 'show', `${ev.rama}:docs/entorno.json`));
  for (const k of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'AWS_REGION', 'MI_API_KEY']) assert.equal(env[k], null, k);
  assert.equal(env.CMD_FALSO_MODO, 'entorno', 'conserva las variables propias del ejecutor');
  assert.ok(env.PATH);
  if (MAC) {
    assert.equal(env.ORQ_SANDBOX, '1');
    assert.match(env.PATH, /shims-macos:/);
  }
  assert.ok(env.TMPDIR.startsWith(path.join(ctx.tmp, 'orq-sb-')), env.TMPDIR);
  assert.ok(!fs.existsSync(env.TMPDIR), 'el temporal propio se borra al terminar');
});

test('sandbox: no se puede leer ni escribir en los temporales de Claude Code', { skip: !MAC && 'solo macOS' }, () => {
  const ctx = entorno();
  const dir = `/tmp/claude-${90000 + (process.pid % 9999)}`;
  fs.mkdirSync(dir, { recursive: true });
  const salida = path.join(dir, 'tarea.output');
  fs.writeFileSync(salida, '⚠ INTEGRIDAD\n');
  try {
    orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'escapa', env: { CMD_FALSO_OBJETIVO: salida } });
    assert.equal(fs.readFileSync(salida, 'utf8'), '⚠ INTEGRIDAD\n');
    orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'lee-fuera', env: { CMD_FALSO_OBJETIVO: salida } });
    const ev = delegaciones(ctx).at(-1);
    assert.equal(git(ctx, 'show', `${ev.rama}:docs/lectura.txt`).trim(), 'bloqueado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sandbox: un repo dentro de /tmp/claude-* (p. ej. el scratchpad de Claude Code) igual funciona', { skip: !MAC && 'solo macOS' }, () => {
  const base = `/tmp/claude-${80000 + (process.pid % 9999)}`;
  try {
    const ctx = entorno({ base });
    const vecino = fs.mkdtempSync(path.join(base, 'vecino-'));
    fs.writeFileSync(path.join(vecino, 'secreto.txt'), 'no\n');
    const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'lee-fuera', env: { CMD_FALSO_OBJETIVO: path.join(vecino, 'secreto.txt') } });
    assert.equal(r.codigo, 0, r.error + r.salida);
    const [ev] = delegaciones(ctx);
    assert.ok(ev.archivos.includes('docs/lectura.txt'));
    assert.equal(git(ctx, 'show', `${ev.rama}:docs/lectura.txt`).trim(), 'bloqueado', 'el resto de /tmp/claude-* sigue cerrado');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('un intento sin cambios no cuenta como integrado: limpiar no borra su worktree y la tarea sigue', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'falla' });
  const [ev] = delegaciones(ctx);
  assert.match(orq(ctx, ['estado']).salida, /sin commits/);
  assert.match(orq(ctx, ['limpiar']).salida, /0 limpiado\(s\); 1 sin integrar/);
  assert.ok(fs.existsSync(path.join(ctx.repo, ev.worktree)));
  const r = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'y' });
  assert.equal(r.codigo, 0, r.error);
  assert.equal(delegaciones(ctx)[1].intento, 2);
});

test('una tarea descartada deja de figurar como abierta en estado y en el scorecard', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  assert.match(orq(ctx, ['estado']).salida, /Tareas abiertas/);
  assert.equal(orq(ctx, ['limpiar', '--descartar', ev.tarea]).codigo, 0);
  assert.doesNotMatch(orq(ctx, ['estado']).salida, /Tareas abiertas/);
  const s = JSON.parse(orq(ctx, ['scorecard', '--json']).salida);
  assert.equal(s.tareas[0].descartadas, 1);
  assert.equal(s.tareas[0].abiertas, 0);
  assert.equal(eventos(ctx).filter((e) => e.tipo === 'descarte').length, 1);
});

test('--dry-run con los intentos agotados informa el escalamiento sin registrarlo', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  orq(ctx, ['delegar', 'tests', '--continuar', ev.tarea], { entrada: 'y' });
  const r = orq(ctx, ['delegar', 'tests', '--continuar', ev.tarea, '--dry-run'], { entrada: 'z' });
  assert.equal(r.codigo, 4);
  assert.match(r.salida, /Escala a:/);
  assert.equal(eventos(ctx).filter((e) => e.tipo === 'escalamiento').length, 0);
  assert.match(orq(ctx, ['estado']).salida, /Tareas abiertas/);
});

test('orq validar corre comandos en el worktree de la tarea, dentro del sandbox', () => {
  const ctx = entorno();
  orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  const [ev] = delegaciones(ctx);
  const ok = orq(ctx, ['validar', ev.tarea, '--', 'ls', 'docs']);
  assert.equal(ok.codigo, 0, ok.error + ok.salida);
  assert.match(ok.salida, /✔ ls docs — código 0/);
  assert.match(ok.salida, /cambio-/);
  if (MAC) assert.match(ok.salida, /sandbox: sandbox-exec/);

  const falla = orq(ctx, ['validar', ev.tarea, '--', 'echo roto >&2; exit 3']);
  assert.equal(falla.codigo, 1);
  assert.match(falla.salida, /✘ echo roto >&2; exit 3 — código 3[\s\S]*roto/);

  // lo que deje sin ignorar en git se descarta; con sandbox, no puede escribir en el checkout principal
  orq(ctx, ['validar', ev.tarea, '--', `echo x > basura.txt; echo y > ${path.join(ctx.repo, 'fuera.txt')}; true`]);
  assert.ok(!fs.existsSync(path.join(ctx.repo, ev.worktree, 'basura.txt')));
  if (MAC) assert.ok(!fs.existsSync(path.join(ctx.repo, 'fuera.txt')));

  assert.equal(orq(ctx, ['validar', ev.tarea]).codigo, 2, 'sin validar en el repo ni comando');
  ajustesRepo(ctx, 'validar:\n  - ls docs\n');
  assert.equal(orq(ctx, ['validar', ev.tarea]).codigo, 0);
  orq(ctx, ['delegar', 'analizar'], { entrada: 'x' });
  const lectura = delegaciones(ctx).at(-1);
  assert.match(orq(ctx, ['validar', lectura.tarea]).error, /solo lectura/);
});

test('un error de git a mitad de la delegación igual queda registrado y con resumen', () => {
  const ctx = entorno({ sandbox: 'desactivado' });
  // el agente deja un index.lock en el gitdir del worktree: el git add de orq falla
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'bloquea-indice' });
  assert.equal(r.codigo, 1, r.error + r.salida);
  assert.match(r.salida, /--- resumen de la delegación ---[\s\S]*orq falló a mitad de la delegación: git add/);
  const [ev] = delegaciones(ctx);
  assert.ok(ev, 'la delegación quedó en el log');
  assert.equal(ev.exit_code, 1);
  // la tarea se puede continuar (o descartar) con normalidad
  assert.match(orq(ctx, ['estado']).salida, new RegExp(`Tareas abiertas[\\s\\S]*${ev.tarea}`));
});

test('con commit.gpgsign activado en el repo, orq commitea igual (sin firmar con tu llave)', () => {
  const ctx = entorno();
  execFileSync('git', ['config', 'commit.gpgsign', 'true'], { cwd: ctx.repo });
  execFileSync('git', ['config', 'gpg.program', '/no/existe/gpg'], { cwd: ctx.repo });
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error + r.salida);
  assert.equal(delegaciones(ctx)[0].archivos.length, 1);
});

test('SIGTERM durante preparar elimina worktree, rama, metadatos y proceso sin dejar rastro', async () => {
  const ctx = entorno();
  ajustesRepo(ctx, 'preparar:\n  - "touch preparado-en-curso.txt; sleep 37.456"\n');
  const hijo = spawn(process.execPath, [ORQ, 'delegar', 'implementar'], {
    cwd: ctx.repo, env: entornoOrq(ctx), stdio: ['pipe', 'ignore', 'ignore'],
  });
  hijo.stdin.end('x');

  const dirWts = path.join(ctx.repo, '.claude', 'worktrees');
  await esperar(() => {
    if (!fs.existsSync(dirWts)) return false;
    return fs.readdirSync(dirWts).some((n) => fs.existsSync(path.join(dirWts, n, 'preparado-en-curso.txt')));
  });
  hijo.kill('SIGTERM');
  const codigo = await new Promise((r) => hijo.on('exit', r));
  assert.equal(codigo, 143);

  await esperar(() => !procesoVivo('sleep 37.456'), 5000);
  assert.equal(git(ctx, 'branch', '--list', 'delegar/*').trim(), '');
  assert.equal(fs.existsSync(dirWts) ? fs.readdirSync(dirWts).length : 0, 0);
  const dirMeta = path.join(ctx.datos, 'logs', 'worktrees');
  assert.equal(fs.existsSync(dirMeta) ? fs.readdirSync(dirMeta).length : 0, 0);
  assert.ok(!fs.existsSync(path.join(ctx.datos, 'logs', 'delegaciones.jsonl')));
});

test('SIGTERM durante validar mantiene el registro de la delegación y descarta restos', async () => {
  const ctx = entorno();
  ajustesRepo(ctx, 'validar:\n  - "touch validar-en-curso.txt; sleep 37.789"\n');
  const hijo = spawn(process.execPath, [ORQ, 'delegar', 'implementar'], {
    cwd: ctx.repo, env: entornoOrq(ctx), stdio: ['pipe', 'ignore', 'ignore'],
  });
  hijo.stdin.end('x');

  const dirWts = path.join(ctx.repo, '.claude', 'worktrees');
  await esperar(() => {
    if (!fs.existsSync(dirWts)) return false;
    return fs.readdirSync(dirWts).some((n) => fs.existsSync(path.join(dirWts, n, 'validar-en-curso.txt')));
  });
  hijo.kill('SIGTERM');
  const codigo = await new Promise((r) => hijo.on('exit', r));
  assert.equal(codigo, 143);

  await esperar(() => !procesoVivo('sleep 37.789'), 5000);
  const [ev] = delegaciones(ctx);
  assert.ok(ev, 'la delegación completada sigue registrada en delegaciones.jsonl');
  assert.equal(ev.archivos.length, 1);
  assert.equal(ev.validacion.ok, false);
  assert.equal(ev.validacion.comandos[0].interrumpida, 'SIGTERM');
  assert.match(ev.alertas.join(' '), /validar interrumpido \(SIGTERM\)/);
  assert.ok(!fs.existsSync(path.join(ctx.repo, ev.worktree, 'validar-en-curso.txt')));
  const dirMeta = path.join(ctx.datos, 'logs', 'worktrees');
  assert.deepEqual(fs.readdirSync(dirMeta).filter((n) => n.endsWith('.lock')), []);
});

test('orq validar descarta archivos nuevos en stage (git add nuevo.txt) y soporta --timeout', () => {
  const ctx = entorno({ sandbox: 'desactivado' });
  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'x' }).codigo, 0);
  const [ev] = delegaciones(ctx);
  const wt = path.join(ctx.repo, ev.worktree);

  const val = orq(ctx, ['validar', ev.tarea, '--', 'mkdir -p temporal && echo hola > temporal/nuevo.txt && git add temporal/nuevo.txt && echo extra >> README.md']);
  assert.equal(val.codigo, 0, val.error + val.salida);
  assert.match(val.salida, /aviso: quedaron cambios que git no ignora y se descartaron:.*temporal\/nuevo\.txt/);
  assert.ok(!fs.existsSync(path.join(wt, 'temporal')));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }).trim(), '');

  const malTimeout = orq(ctx, ['validar', ev.tarea, '--timeout', '0', '--', 'true']);
  assert.equal(malTimeout.codigo, 2);
  const timeout = orq(ctx, ['validar', ev.tarea, '--timeout', '0.02', '--', 'sleep 37.654']);
  assert.equal(timeout.codigo, 1);
  assert.match(timeout.salida, /\(timeout\)/);
  assert.ok(!procesoVivo('sleep 37.654'));
});

test('orq delegar: NDJSON truncado, subtype max_turns y sin texto salen con 1', () => {
  const ctx = entorno();
  const trunc = orq(ctx, ['delegar', 'implementar'], {
    entrada: 'x', modo: 'ndjson-truncado', env: { CMD_FALSO_AVISO: 'corte abrupto' },
  });
  assert.equal(trunc.codigo, 1);
  assert.match(delegaciones(ctx).at(-1).alertas.join(' '), /Command Code terminó sin evento final JSON: corte abrupto/);

  const maxTurns = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'max-turns' });
  assert.equal(maxTurns.codigo, 1);
  assert.match(delegaciones(ctx).at(-1).alertas.join(' '), /Command Code reportó un error: max_turns/);

  const vacio = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', modo: 'sin-texto' });
  assert.equal(vacio.codigo, 1);
  assert.match(delegaciones(ctx).at(-1).alertas.join(' '), /Command Code terminó sin respuesta/);
});

test('validar muestra todas las fallas en el resumen y preparar multi-comando se detiene al primer fallo', () => {
  const ctx = entorno();
  ajustesRepo(ctx, [
    'validar:',
    '  - "echo error-uno >&2; exit 3"',
    '  - "echo error-dos >&2; exit 4"',
    '',
  ].join('\n'));
  const r = orq(ctx, ['delegar', 'implementar'], { entrada: 'x' });
  assert.equal(r.codigo, 0, r.error + r.salida);
  assert.match(r.salida, /validar: ✘ "echo error-uno >&2; exit 3" terminó con código 3/);
  assert.match(r.salida, /error-uno/);
  assert.match(r.salida, /validar: ✘ "echo error-dos >&2; exit 4" terminó con código 4/);
  assert.match(r.salida, /error-dos/);
  assert.deepEqual(delegaciones(ctx)[0].validacion.comandos.map((c) => c.codigo), [3, 4]);

  ajustesRepo(ctx, [
    'preparar:',
    '  - "echo paso1; exit 7"',
    '  - "echo nunca-debe-correr"',
    '',
  ].join('\n'));
  const prep = orq(ctx, ['delegar', 'tests'], { entrada: 'x' });
  assert.equal(prep.codigo, 1);
  assert.match(prep.error, /Falló preparar: "echo paso1; exit 7" terminó con código 7/);
  const dirSalidas = path.join(ctx.datos, 'logs', 'salidas');
  const logsPrep = fs.readdirSync(dirSalidas).filter((n) => n.endsWith('.preparar.log'));
  assert.equal(logsPrep.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(dirSalidas, logsPrep[0]), 'utf8'), /nunca-debe-correr/);
  assert.equal(git(ctx, 'branch', '--list', 'delegar/*tests*').trim(), '');
});

test('repo con 0 commits devuelve error claro y --continuar concurrente respeta el lock', async () => {
  const ctx = entorno();
  const sinCommits = path.join(ctx.dir, 'repo-vacio');
  fs.mkdirSync(sinCommits);
  execFileSync('git', ['init', '-q'], { cwd: sinCommits });
  const r0 = orq(ctx, ['delegar', 'implementar'], { entrada: 'x', cwd: sinCommits });
  assert.equal(r0.codigo, 2);
  assert.match(r0.error, /aún no tiene ningún commit/);
  assert.ok(!fs.existsSync(ctx.llamadas));

  assert.equal(orq(ctx, ['delegar', 'implementar'], { entrada: 'x' }).codigo, 0);
  const [ev] = delegaciones(ctx);
  const hijo = spawn(process.execPath, [ORQ, 'delegar', 'implementar', '--continuar', ev.tarea], {
    cwd: ctx.repo, env: entornoOrq(ctx, { modo: 'cuelga' }), stdio: ['pipe', 'ignore', 'ignore'],
  });
  hijo.stdin.end('y');
  await esperar(() => fs.existsSync(ctx.llamadas) && fs.readFileSync(ctx.llamadas, 'utf8').trim().split('\n').length >= 2);

  const conc = orq(ctx, ['delegar', 'implementar', '--continuar', ev.tarea], { entrada: 'z' });
  assert.equal(conc.codigo, 2);
  assert.match(conc.error, /Ya hay una delegación en curso para la tarea/);
  assert.equal(fs.readFileSync(ctx.llamadas, 'utf8').trim().split('\n').length, 2);

  hijo.kill('SIGTERM');
  assert.equal(await new Promise((r) => hijo.on('exit', r)), 143);
  await esperar(() => !procesoVivo('sleep 37.123'), 5000);
});

test('integridad: con sandbox activo, cambios externos de IDE/HEAD pasan a alertas; sin sandbox son críticas', async () => {
  const correrConCambioExterno = async (sandbox) => {
    const ctx = entorno({ sandbox });
    const seguir = path.join(path.dirname(ctx.llamadas), 'seguir');
    const hijo = spawn(process.execPath, [ORQ, 'delegar', 'implementar'], {
      cwd: ctx.repo,
      env: entornoOrq(ctx, { env: { CMD_FALSO_ESPERAR: seguir } }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stdin.end('x');

    await esperar(() => fs.existsSync(ctx.llamadas));
    fs.mkdirSync(path.join(ctx.repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ctx.repo, '.claude', 'settings.json'), '{"permissions":{}}\n');
    git(ctx, 'commit', '-q', '--allow-empty', '-m', 'cambio externo del usuario');
    fs.writeFileSync(seguir, 'ok\n');

    const codigo = await new Promise((r) => hijo.on('exit', r));
    return { ctx, codigo, salida, ev: delegaciones(ctx)[0] };
  };

  const sin = await correrConCambioExterno('desactivado');
  assert.equal(sin.codigo, 5, sin.salida);
  assert.match(sin.ev.criticas.join(' '), /\.claude\/settings\.json/);
  assert.match(sin.ev.criticas.join(' '), /checkout principal cambió de commit o de rama/);

  if (!MAC) return;
  const con = await correrConCambioExterno(undefined);
  assert.equal(con.codigo, 0, con.salida);
  assert.deepEqual(con.ev.criticas, []);
  assert.match(con.ev.alertas.join(' '), /\.claude\/settings\.json/);
  assert.match(con.ev.alertas.join(' '), /checkout principal cambió de commit o de rama/);
});
