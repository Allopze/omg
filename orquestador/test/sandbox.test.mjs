import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  perfilMacos, argsBwrap, politicaSandbox, envolverEnSandbox, entornoSandbox, DIR_SHIMS_MACOS, rutaReal, configSandbox,
} from '../lib/sandbox.mjs';
import { SALIDA } from '../lib/registro.mjs';

const registro = (sandbox) => ({ sandbox });

test('configSandbox: auto por defecto; acepta la sección de la 0.3 (command_code.sandbox)', () => {
  assert.deepEqual(configSandbox({}), { modo: 'auto', escritura_extra: [], lectura_denegada: [], lectura_extra: [] });
  assert.equal(configSandbox(registro({ modo: 'desactivado' })).modo, 'desactivado');
  assert.equal(configSandbox({ command_code: { sandbox: { modo: 'obligatorio' } } }).modo, 'obligatorio');
});

test('la política suma worktree, temporales, cachés y extras; separa lecturas denegadas, legibles y credenciales', () => {
  const pol = politicaSandbox(registro({ escritura_extra: ['~/mi-cache'], lectura_denegada: ['~/clientes'], lectura_extra: ['~/clientes/ref'] }), {
    escribibles: ['/no/existe/wt'], protegidas: ['/no/existe/wt/.git'], legibles: ['/no/existe/repo'],
  });
  const home = rutaReal(os.homedir());
  assert.ok(pol.escritura.includes('/no/existe/wt'));
  assert.ok(pol.escritura.includes(rutaReal(os.tmpdir())));
  assert.ok(pol.escritura.includes(path.join(home, '.npm')));
  assert.ok(pol.escritura.includes(path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData')));
  assert.ok(pol.escritura.includes(path.join(home, 'mi-cache')));
  assert.ok(!pol.escritura.includes(path.join(home, '.commandcode')), 'el estado del ejecutor lo aporta su adaptador');
  assert.deepEqual(pol.protegida, ['/no/existe/wt/.git']);
  assert.deepEqual(pol.lecturaDenegada, [path.join(home, 'clientes')]);
  assert.deepEqual(pol.lecturaExtra, [path.join(home, 'clientes', 'ref')]);
  assert.deepEqual(pol.legibles, ['/no/existe/repo']);
  assert.ok(pol.credenciales.includes(path.join(home, '.ssh')));
  assert.ok(!pol.lecturaDenegada.includes(path.join(home, '.ssh')), 'las credenciales no se pueden reabrir');
});

test('perfil de macOS: orden de reglas y operaciones verificadas en sandbox-exec', () => {
  const perfil = perfilMacos({
    escritura: ['/wt', '/tmp "raro"'], protegida: ['/wt/.git'], lecturaDenegada: ['/dev-u'],
    lecturaExtra: ['/dev-u/ref'], legibles: ['/dev-u/repo'], credenciales: ['/home/u/.ssh'],
  });
  const lineas = perfil.trim().split('\n');
  const pos = (l) => {
    const i = lineas.indexOf(l);
    assert.ok(i !== -1, `falta: ${l}`);
    return i;
  };
  assert.equal(lineas[1], '(allow default)');
  assert.equal(lineas[2], '(deny file-write*)');
  const escribe = pos('(allow file-write* (subpath "/wt"))');
  const protege = pos('(deny file-write* (subpath "/wt/.git"))');
  const niega = pos('(deny file-read-data (subpath "/dev-u"))');
  const reabre = pos('(allow file-read-data (subpath "/dev-u/repo"))');
  const reabreExtra = pos('(allow file-read-data (subpath "/dev-u/ref"))');
  const leeEscribible = pos('(allow file-read-data (subpath "/wt"))');
  const credData = pos('(deny file-read-data (subpath "/home/u/.ssh"))');
  const credTodo = pos('(deny file-read* file-write* (subpath "/home/u/.ssh"))');
  assert.ok(escribe < protege, 'la protección de .git va después del permiso de escritura');
  assert.ok(niega < reabre && niega < reabreExtra && niega < leeEscribible, 'lo legible se reabre después de lo denegado');
  assert.ok(!lineas.includes('(allow file-write* (subpath "/dev-u/ref"))'), 'lectura_extra es solo lectura');
  assert.ok(reabre < credData && reabreExtra < credData && credData < credTodo, 'las credenciales van al final, con file-read-data explícito');
  pos('(allow file-write* (subpath "/tmp \\"raro\\""))');
});

test('bwrap: raíz de solo lectura, carpetas denegadas vacías, lo legible encima y credenciales ocultas', () => {
  const existe = (p) => p !== '/no-existe';
  const esDirectorio = (p) => !p.endsWith('.json');
  const args = argsBwrap(
    {
      escritura: ['/wt', '/no-existe'], protegida: ['/wt/.git'], lecturaDenegada: ['/dev-u'],
      lecturaExtra: ['/dev-u/ref'], legibles: ['/dev-u/repo', '/wt'], credenciales: ['/h/.ssh', '/h/.docker/config.json'],
    },
    '/wt', existe, esDirectorio,
  );
  const s = args.join(' ');
  assert.deepEqual(args.slice(0, 3), ['--ro-bind', '/', '/']);
  assert.ok(!args.includes('/no-existe'));
  const i = (frag) => {
    const n = s.indexOf(frag);
    assert.ok(n !== -1, `falta: ${frag}`);
    return n;
  };
  assert.ok(i('--tmpfs /dev-u') < i('--ro-bind /dev-u/repo /dev-u/repo'));
  assert.ok(i('--tmpfs /dev-u') < i('--ro-bind /dev-u/ref /dev-u/ref'));
  assert.ok(s.lastIndexOf('--bind /wt /wt') > i('--tmpfs /dev-u'), 'el worktree se vuelve a montar escribible');
  assert.ok(i('--ro-bind /wt/.git /wt/.git') > s.lastIndexOf('--bind /wt /wt'));
  assert.ok(i('--tmpfs /h/.ssh') > i('--ro-bind /wt/.git'));
  i('--ro-bind /dev/null /h/.docker/config.json');
  assert.deepEqual(args.slice(-2), ['--chdir', '/wt']);
});

test('entornoSandbox: exporta ORQ_SANDBOX=1 y antepone shims de macOS solo con sandbox-exec', () => {
  const base = { PATH: '/usr/bin:/bin' };
  assert.deepEqual(entornoSandbox(base, null), base);
  assert.deepEqual(entornoSandbox(base, 'bwrap'), { PATH: '/usr/bin:/bin', ORQ_SANDBOX: '1' });
  const mac = entornoSandbox(base, 'sandbox-exec');
  assert.equal(mac.ORQ_SANDBOX, '1');
  assert.equal(mac.PATH, `${DIR_SHIMS_MACOS}:/usr/bin:/bin`);
  // no duplica si ya estaba
  assert.equal(entornoSandbox(mac, 'sandbox-exec').PATH, mac.PATH);
});

test('shims-macos: xcodebuild y swift desactivan el sandbox anidado solo cuando compilan', () => {
  const binFalso = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-shim-test-'));
  const registrar = '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n';
  for (const nombre of ['xcodebuild', 'swift']) {
    const p = path.join(binFalso, nombre);
    fs.writeFileSync(p, registrar, { mode: 0o755 });
  }
  const correr = (bin, args) => {
    const r = spawnSync(path.join(DIR_SHIMS_MACOS, bin), args, {
      env: { ...process.env, PATH: `${DIR_SHIMS_MACOS}:${binFalso}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? r.stdout.replace(/\n$/, '').split('\n') : [];
  };
  try {
    // xcodebuild: consultas y test-without-building pasan sin tocar
    assert.deepEqual(correr('xcodebuild', ['-version']), ['-version']);
    assert.deepEqual(correr('xcodebuild', ['-project', 'App.xcodeproj', '-list']), ['-project', 'App.xcodeproj', '-list']);
    assert.deepEqual(correr('xcodebuild', ['test-without-building', '-xctestrun', 'a.xctestrun']), ['test-without-building', '-xctestrun', 'a.xctestrun']);
    assert.deepEqual(correr('xcodebuild', ['-project', 'App.xcodeproj', 'clean']), ['-project', 'App.xcodeproj', 'clean']);

    // xcodebuild: acciones de compilación inyectan ambos flags y preservan espacios y valores existentes
    assert.deepEqual(
      correr('xcodebuild', ['-project', 'Mi App.xcodeproj', '-scheme', 'App', 'build']),
      ['-project', 'Mi App.xcodeproj', '-scheme', 'App', 'build', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['-project', 'App.xcodeproj', 'clean', 'build']),
      ['-project', 'App.xcodeproj', 'clean', 'build', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['build', 'OTHER_SWIFT_FLAGS=-DDEBUG -DFOO', 'ENABLE_USER_SCRIPT_SANDBOXING=YES']),
      ['build', 'OTHER_SWIFT_FLAGS=-DDEBUG -DFOO -Xfrontend -disable-sandbox', 'ENABLE_USER_SCRIPT_SANDBOXING=YES'],
    );

    // swift: build/test/run desactivan sandbox; --version, -e y --help pasan sin tocar
    assert.deepEqual(correr('swift', ['--version']), ['--version']);
    assert.deepEqual(correr('swift', ['-e', 'print(1)']), ['-e', 'print(1)']);
    assert.deepEqual(correr('swift', ['build', '--help']), ['build', '--help']);
    assert.deepEqual(
      correr('swift', ['test', '--filter', 'MiTest']),
      ['test', '--disable-sandbox', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox', '--filter', 'MiTest'],
    );
    assert.deepEqual(
      correr('swift', ['run', 'cli', '--', '--help']),
      ['run', '--disable-sandbox', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox', 'cli', '--', '--help'],
    );
  } finally {
    fs.rmSync(binFalso, { recursive: true, force: true });
  }
});

test('envolver: desactivado no envuelve, obligatorio sin sandbox bloquea, auto sin sandbox avisa', () => {
  const base = { bin: 'cmd', args: ['-p'], cwd: '/wt', escribibles: ['/wt'] };
  assert.deepEqual(envolverEnSandbox(registro({ modo: 'desactivado' }), base), { bin: 'cmd', args: ['-p'], sandbox: null, aviso: null });

  const sin = { tipo: null, motivo: 'no hay' };
  assert.throws(
    () => envolverEnSandbox(registro({ modo: 'obligatorio' }), { ...base, disponible: sin }),
    (e) => e.codigo === SALIDA.BLOQUEADO && /obligatorio/.test(e.message),
  );
  const auto = envolverEnSandbox(registro({}), { ...base, disponible: sin });
  assert.equal(auto.bin, 'cmd');
  assert.match(auto.aviso, /Sin sandbox \(no hay\)/);

  const mac = envolverEnSandbox(registro({}), { ...base, disponible: { tipo: 'sandbox-exec' } });
  assert.equal(mac.bin, 'sandbox-exec');
  assert.equal(mac.args[0], '-p');
  assert.deepEqual(mac.args.slice(2), ['cmd', '-p']);

  const linux = envolverEnSandbox(registro({}), { ...base, disponible: { tipo: 'bwrap' } });
  assert.equal(linux.bin, 'bwrap');
  assert.deepEqual(linux.args.slice(linux.args.indexOf('--')), ['--', 'cmd', '-p']);
});
