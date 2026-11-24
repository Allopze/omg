import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  perfilMacos, argsBwrap, politicaSandbox, envolverEnSandbox, entornoSandbox,
  DIR_SHIMS_MACOS, ESCRITURA_BASE, LECTURA_DENEGADA_BASE, rutaReal, configSandbox, sandboxActivo,
} from '../lib/sandbox.mjs';
import { SALIDA } from '../lib/registro.mjs';

const registro = (sandbox) => ({ sandbox });

test('configSandbox: auto por defecto; acepta la sección de la 0.3 (command_code.sandbox)', () => {
  assert.deepEqual(configSandbox({}), {
    modo: 'auto', escritura_extra: [], lectura_denegada: [], lectura_extra: [], preparar_con_credenciales: false,
  });
  assert.equal(configSandbox(registro({ modo: 'desactivado' })).modo, 'desactivado');
  assert.equal(configSandbox(registro({ preparar_con_credenciales: true })).preparar_con_credenciales, true);
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
  const legiblesEsperados = ['/no/existe/repo', ...(process.platform === 'darwin' ? [rutaReal(DIR_SHIMS_MACOS)] : [])];
  assert.deepEqual(pol.legibles, legiblesEsperados);
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

test('shims-macos: xcodebuild, swift y swiftc desactivan el sandbox anidado solo cuando compilan', () => {
  const binFalso = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-shim-test-'));
  const registrar = '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n';
  for (const nombre of ['xcodebuild', 'swift', 'swiftc']) {
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

    // xcodebuild: acciones de compilación (y `-scheme clean` / `-scheme test-without-building`) inyectan ambos flags
    assert.deepEqual(
      correr('xcodebuild', ['-project', 'Mi App.xcodeproj', '-scheme', 'App', 'build']),
      ['-project', 'Mi App.xcodeproj', '-scheme', 'App', 'build', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['-project', 'App.xcodeproj', 'clean', 'build']),
      ['-project', 'App.xcodeproj', 'clean', 'build', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['-scheme', 'clean']),
      ['-scheme', 'clean', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['-scheme', 'clean', 'build']),
      ['-scheme', 'clean', 'build', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['-scheme', 'test-without-building', 'build']),
      ['-scheme', 'test-without-building', 'build', 'ENABLE_USER_SCRIPT_SANDBOXING=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox'],
    );
    assert.deepEqual(
      correr('xcodebuild', ['build', 'OTHER_SWIFT_FLAGS=-DDEBUG -DFOO', 'ENABLE_USER_SCRIPT_SANDBOXING=YES']),
      ['build', 'OTHER_SWIFT_FLAGS=-DDEBUG -DFOO -Xfrontend -disable-sandbox', 'ENABLE_USER_SCRIPT_SANDBOXING=YES'],
    );

    // swift: build/test/run/package desactivan sandbox; --version, -e y --help propio pasan sin tocar
    assert.deepEqual(correr('swift', ['--version']), ['--version']);
    assert.deepEqual(correr('swift', ['-e', 'print(1)']), ['-e', 'print(1)']);
    assert.deepEqual(correr('swift', ['build', '--help']), ['build', '--help']);
    assert.deepEqual(correr('swift', ['run', '--help']), ['run', '--help']);
    assert.deepEqual(correr('swift', ['package', '--help']), ['package', '--help']);
    assert.deepEqual(
      correr('swift', ['package', 'resolve']),
      ['package', '--disable-sandbox', 'resolve'],
    );
    assert.deepEqual(
      correr('swift', ['package', '--disable-sandbox', 'resolve']),
      ['package', '--disable-sandbox', 'resolve'],
    );
    assert.deepEqual(
      correr('swift', ['test', '--filter', 'MiTest']),
      ['test', '--disable-sandbox', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox', '--filter', 'MiTest'],
    );
    assert.deepEqual(
      correr('swift', ['run', 'cli', '--help']),
      ['run', '--disable-sandbox', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox', 'cli', '--help'],
    );
    assert.deepEqual(
      correr('swift', ['run', 'cli', '--', '--help']),
      ['run', '--disable-sandbox', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox', 'cli', '--', '--help'],
    );
    assert.deepEqual(
      correr('swift', ['build', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox']),
      ['build', '--disable-sandbox', '-Xswiftc', '-Xfrontend', '-Xswiftc', '-disable-sandbox'],
    );

    // swiftc: frontend vs driver vs consultas/flags existentes
    assert.deepEqual(correr('swiftc', []), []);
    assert.deepEqual(correr('swiftc', ['--version']), ['--version']);
    assert.deepEqual(correr('swiftc', ['-print-target-info']), ['-print-target-info']);
    assert.deepEqual(correr('swiftc', ['-help']), ['-help']);
    assert.deepEqual(
      correr('swiftc', ['-frontend', '-typecheck', 'a.swift']),
      ['-frontend', '-disable-sandbox', '-typecheck', 'a.swift'],
    );
    assert.deepEqual(
      correr('swiftc', ['-O', '-frontend', 'a.swift']),
      ['-O', '-frontend', 'a.swift', '-disable-sandbox'],
    );
    assert.deepEqual(
      correr('swiftc', ['a.swift', '-o', 'a']),
      ['-Xfrontend', '-disable-sandbox', 'a.swift', '-o', 'a'],
    );
    assert.deepEqual(
      correr('swiftc', ['-Xfrontend', '-disable-sandbox', 'a.swift']),
      ['-Xfrontend', '-disable-sandbox', 'a.swift'],
    );
  } finally {
    fs.rmSync(binFalso, { recursive: true, force: true });
  }
});

test('envolver: desactivado no envuelve, obligatorio sin sandbox bloquea, auto sin sandbox avisa', () => {
  const base = { bin: 'cmd', args: ['-p'], cwd: '/wt', escribibles: ['/wt'] };
  assert.deepEqual(envolverEnSandbox(registro({ modo: 'desactivado' }), base), { bin: 'cmd', args: ['-p'], sandbox: null, aviso: null });
  assert.equal(sandboxActivo(registro({ modo: 'desactivado' }), { tipo: 'sandbox-exec' }), false);
  assert.equal(sandboxActivo(registro({}), { tipo: null }), false);
  assert.equal(sandboxActivo(registro({}), { tipo: 'sandbox-exec' }), true);

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

test('politicaSandbox incluye DIR_SHIMS_MACOS solo en darwin y expande toda ESCRITURA_BASE', () => {
  const polDarwin = politicaSandbox({}, { legibles: ['/r'], plataforma: 'darwin' });
  const shimsReal = rutaReal(DIR_SHIMS_MACOS);
  assert.ok(polDarwin.legibles.includes(shimsReal));
  assert.ok(polDarwin.noEscribible.includes(shimsReal));
  assert.ok(polDarwin.propias.legibles.includes(shimsReal));
  const perfil = perfilMacos(polDarwin);
  assert.ok(perfil.includes(`(allow file-read-data (subpath "${shimsReal}"))`));
  assert.ok(perfil.includes(`(deny file-write* (subpath "${shimsReal}"))`));

  const polLinux = politicaSandbox({}, { legibles: ['/r'], plataforma: 'linux' });
  assert.ok(!polLinux.legibles.includes(shimsReal));
  assert.equal(polLinux.darwinTmp, null);

  for (const ruta of ESCRITURA_BASE) {
    assert.ok(polDarwin.escritura.includes(rutaReal(ruta)), `falta ${ruta} en escritura`);
  }
});

test('preparar_con_credenciales: true solo libera credenciales y sockets cuando confiable es true', () => {
  const prevSock = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/tmp/ssh-test.sock';
  try {
    const regCred = registro({ preparar_con_credenciales: true });
    const regSinCred = registro({ preparar_con_credenciales: false });
    const ssh = rutaReal('~/.ssh');
    const aws = rutaReal('~/.aws');

    // No confiable (p. ej. modelo delegado o validar): sigue bloqueado aunque preparar_con_credenciales sea true
    const noConfiable = politicaSandbox(regCred, { confiable: false, credencialesExtra: ['~/.npmrc'] });
    assert.ok(noConfiable.credenciales.includes(ssh));
    assert.ok(noConfiable.credenciales.includes(aws));
    assert.ok(noConfiable.credenciales.includes(rutaReal('~/.npmrc')));
    assert.ok(noConfiable.sockets.includes(rutaReal('/tmp/ssh-test.sock')));
    assert.equal(noConfiable.bloquearAgenteSsh, true);
    assert.match(perfilMacos(noConfiable), /com\\\.apple\\\.launchd/);

    // Confiable pero preparar_con_credenciales false: sigue bloqueado
    const confiableSinFlag = politicaSandbox(regSinCred, { confiable: true });
    assert.ok(confiableSinFlag.credenciales.includes(ssh));
    assert.equal(confiableSinFlag.bloquearAgenteSsh, true);

    // Confiable y preparar_con_credenciales true: libera credenciales base y sockets, pero protege .credentials.json y credencialesExtra
    const confiableConFlag = politicaSandbox(regCred, { confiable: true, credencialesExtra: ['~/.commandcode/auth.json'] });
    for (const c of LECTURA_DENEGADA_BASE) {
      assert.ok(!confiableConFlag.credenciales.includes(rutaReal(c)), `no debe bloquear ${c}`);
    }
    assert.ok(confiableConFlag.credenciales.some((p) => p.endsWith('/.credentials.json')));
    assert.ok(confiableConFlag.credenciales.includes(rutaReal('~/.commandcode/auth.json')));
    assert.deepEqual(confiableConFlag.sockets, []);
    assert.equal(confiableConFlag.bloquearAgenteSsh, false);
    const perfilConfiable = perfilMacos(confiableConFlag);
    assert.doesNotMatch(perfilConfiable, /com\\\.apple\\\.launchd/);
    assert.doesNotMatch(perfilConfiable, /\.gnupg/);
  } finally {
    if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = prevSock;
  }
});
