// Prueba el instalador global en un HOME temporal aislado por test. Ejecutar con: node --test pruebas/*.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashRegistro } from '../orquestador/lib/registro-texto.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALAR = path.join(RAIZ, 'instalar.mjs');
const INSTALAR_SH = path.join(RAIZ, 'instalar.sh');
const CMD_FALSO = path.join(RAIZ, 'orquestador', 'test', 'fixtures', 'cmd-falso.mjs');
const AGY_FALSO = path.join(RAIZ, 'orquestador', 'test', 'fixtures', 'agy-falso.mjs');

const NPM_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-npm-cache-'));
after(() => fs.rmSync(NPM_CACHE, { recursive: true, force: true }));

const leer = (p) => fs.readFileSync(p, 'utf8');

function crearEntorno(t, {
  shell = '/bin/zsh',
  zshrcContenido = 'alias ll="ls -la"\n',
  settingsIniciales = { model: 'opus', permissions: { allow: ['Bash(npm test)', 'Bash(git status)'] } },
} = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-inst-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const home = path.join(raiz, 'home');
  const claude = path.join(home, '.claude');
  const dest = path.join(claude, 'orquestador');
  const shim = path.join(home, '.local', 'bin', 'orq');
  const zshrc = path.join(home, '.zshrc');
  const bashRc = path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  const fishConf = path.join(home, '.config', 'fish', 'conf.d', 'orquestador.fish');
  const settingsRuta = path.join(claude, 'settings.json');
  const tmpDir = path.join(raiz, 'tmp');

  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  if (settingsIniciales !== null) fs.writeFileSync(settingsRuta, JSON.stringify(settingsIniciales));
  if (shell === '/bin/zsh' && zshrcContenido !== null) fs.writeFileSync(zshrc, zshrcContenido);

  const env = (extra = {}) => {
    const e = {
      ...process.env,
      HOME: home,
      TMPDIR: tmpDir,
      SHELL: shell,
      PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      ORQ_CMD_BIN: CMD_FALSO,
      ORQ_AGY_BIN: AGY_FALSO,
      npm_config_cache: NPM_CACHE,
    };
    delete e.CLAUDE_CONFIG_DIR;
    delete e.ZDOTDIR;
    delete e.ORQ_HOME;
    delete e.ORQ_BIN_DIR;
    delete e.ORQ_AGY_SETTINGS;
    return { ...e, ...extra };
  };

  const instalarCon = (extra, ...args) => {
    const r = spawnSync(process.execPath, [INSTALAR, ...args], { env: env(extra), encoding: 'utf8' });
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
  };
  const instalar = (...args) => instalarCon({}, ...args);
  const settings = () => JSON.parse(leer(settingsRuta));
  const mkdtemp = (prefijo = 'aux-') => fs.mkdtempSync(path.join(raiz, prefijo));

  return {
    raiz, home, claude, dest, shim, zshrc, bashRc, fishConf, settingsRuta, tmpDir,
    env, instalarCon, instalar, settings, mkdtemp,
  };
}

test('simular no modifica nada', (t) => {
  const ent = crearEntorno(t);
  const antes = leer(ent.settingsRuta);
  const r = ent.instalar('--simular');
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Simulación terminada/);
  assert.equal(leer(ent.settingsRuta), antes);
  assert.ok(!fs.existsSync(ent.dest));
  assert.ok(!fs.existsSync(ent.shim));
});

test('instala todo a nivel de usuario', (t) => {
  const ent = crearEntorno(t);
  const r = ent.instalar();
  assert.equal(r.codigo, 0, r.salida);
  for (const p of ['bin/orq.mjs', 'lib/shims-macos/xcodebuild', 'lib/shims-macos/swift', 'models.yaml', 'node_modules/yaml', 'instalacion.json', 'VERSION']) {
    assert.ok(fs.existsSync(path.join(ent.dest, p)), p);
  }
  assert.ok((fs.statSync(path.join(ent.dest, 'lib', 'shims-macos', 'xcodebuild')).mode & 0o111) !== 0, 'xcodebuild shim ejecutable');
  assert.ok((fs.statSync(path.join(ent.dest, 'lib', 'shims-macos', 'swift')).mode & 0o111) !== 0, 'swift shim ejecutable');
  assert.ok(fs.existsSync(path.join(ent.claude, 'skills', 'orquestar', 'SKILL.md')));
  for (const a of ['Explore', 'analista-sonnet', 'implementador-sonnet', 'documentador-haiku']) {
    assert.ok(fs.existsSync(path.join(ent.claude, 'agents', `${a}.md`)), a);
  }
  const skill = leer(path.join(ent.claude, 'skills', 'orquestar', 'SKILL.md'));
  assert.match(skill, /orq estado/);
  assert.doesNotMatch(skill, /ENRUTAMIENTO/);
  for (const p of ['test', '.instalando', '.anterior', 'comandos/generar-skill.mjs']) {
    assert.ok(!fs.existsSync(path.join(ent.dest, p)), `no instala ${p}`);
  }

  const s = ent.settings();
  assert.equal(s.model, 'opus');
  assert.ok(s.permissions.allow.includes('Bash(npm test)'));
  assert.equal(s.permissions.allow.filter((x) => x === 'Bash(git status)').length, 1);
  assert.ok(s.permissions.allow.includes('Bash(orq delegar *)'));
  assert.ok(s.permissions.deny.includes(`Edit(/${ent.dest}/**)`));
  assert.ok(fs.existsSync(`${ent.settingsRuta}.bak-orquestador`));

  const man = JSON.parse(leer(path.join(ent.dest, 'instalacion.json')));
  assert.ok(!man.reglas.allow.includes('Bash(git status)'), 'no se apropia de reglas que ya eran tuyas');

  assert.match(leer(ent.zshrc), /alias ll/);
  assert.match(leer(ent.zshrc), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);

  const v = spawnSync(ent.shim, ['--version'], { env: ent.env(), encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  assert.match(r.salida, /Todo en orden|problema/);

  // Si en el PATH hay un node < 20, el shim cae al ejecutable usado al instalar
  const binNodeViejo = ent.mkdtemp('node-viejo-');
  const nodeViejo = path.join(binNodeViejo, 'node');
  fs.writeFileSync(nodeViejo, '#!/bin/sh\necho v18.19.0\n');
  fs.chmodSync(nodeViejo, 0o755);
  const vFallback = spawnSync(ent.shim, ['--version'], {
    env: ent.env({ PATH: [binNodeViejo, '/usr/bin', '/bin'].join(':') }),
    encoding: 'utf8',
  });
  assert.equal(vFallback.status, 0, vFallback.stderr);
  assert.match(vFallback.stdout, /^\d+\.\d+\.\d+/);
});

test('reinstalar es idempotente y conserva tus cambios', (t) => {
  const ent = crearEntorno(t);
  assert.equal(ent.instalar().codigo, 0);

  fs.appendFileSync(path.join(ent.dest, 'models.yaml'), '\n# mi cambio\n');
  fs.appendFileSync(path.join(ent.claude, 'agents', 'Explore.md'), '\nMi ajuste.\n');
  fs.mkdirSync(path.join(ent.dest, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ent.dest, 'logs', 'delegaciones.jsonl'), '{"tipo":"delegacion","id":"x"}\n');
  // restos de una instalación 0.2: test/ y el comando generar-skill
  fs.mkdirSync(path.join(ent.dest, 'test'), { recursive: true });
  fs.writeFileSync(path.join(ent.dest, 'test', 'viejo.test.mjs'), '');
  fs.writeFileSync(path.join(ent.dest, 'comandos', 'generar-skill.mjs'), '');

  const r = ent.instalar();
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Actualizando el orquestador/);
  assert.ok(!fs.existsSync(path.join(ent.dest, 'test')));
  assert.ok(!fs.existsSync(path.join(ent.dest, 'comandos', 'generar-skill.mjs')));
  assert.match(leer(path.join(ent.dest, 'models.yaml')), /# mi cambio/);
  assert.ok(fs.existsSync(path.join(ent.dest, 'models.yaml.nuevo')));
  assert.match(leer(path.join(ent.claude, 'agents', 'Explore.md')), /Mi ajuste/);
  assert.match(r.salida, /Se conserva tu subagente Explore/);
  assert.ok(fs.existsSync(path.join(ent.dest, 'logs', 'delegaciones.jsonl')));
  assert.equal(leer(ent.zshrc).match(/>>> orquestador >>>/g).length, 1);
  const allow = ent.settings().permissions.allow;
  assert.equal(allow.length, new Set(allow).size);

  const f = ent.instalar('--forzar');
  assert.equal(f.codigo, 0, f.salida);
  assert.doesNotMatch(leer(path.join(ent.claude, 'agents', 'Explore.md')), /Mi ajuste/);
});

test('si npm ci falla, la instalación anterior queda intacta', (t) => {
  const ent = crearEntorno(t);
  assert.equal(ent.instalar().codigo, 0);

  const antes = leer(path.join(ent.dest, 'bin', 'orq.mjs'));
  const r = ent.instalarCon({
    npm_config_cache: ent.mkdtemp('npm-vacio-'),
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_fetch_retries: '0',
    npm_config_offline: 'false',
  });
  assert.equal(r.codigo, 1, r.salida);
  assert.match(r.salida, /la instalación anterior quedó intacta/);
  assert.equal(leer(path.join(ent.dest, 'bin', 'orq.mjs')), antes);
  assert.ok(fs.existsSync(path.join(ent.dest, 'node_modules', 'yaml')));
  assert.ok(!fs.existsSync(path.join(ent.dest, '.instalando')));
  const v = spawnSync(ent.shim, ['--version'], { env: ent.env(), encoding: 'utf8' });
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test('actualiza el registro si no lo modificaste desde que lo instaló', (t) => {
  const ent = crearEntorno(t);
  assert.equal(ent.instalar().codigo, 0);

  const rutaManifiesto = path.join(ent.dest, 'instalacion.json');
  const registro = path.join(ent.dest, 'models.yaml');
  const tuyo = leer(registro);
  // simula un registro que instaló una versión anterior y que nunca editaste
  // con resultados de la Fase 0 (orq verificar --guardar), que no cuentan como modificación y se conservan
  const viejo = '# registro de una versión anterior\ncommand_code:\n  bin: cmd\n  skills_compatibles: true\n  salida_json: false\n' +
    'antigravity:\n  permitir_cuenta_personal: false\nsandbox:\n  lectura_denegada: ["~/trabajo"]\n  lectura_extra: ["~/trabajo/refs"]\nmodels: {}\n';
  fs.writeFileSync(registro, viejo);
  const man = JSON.parse(leer(rutaManifiesto));
  man.registro = hashRegistro(viejo.replace('skills_compatibles: true', 'skills_compatibles: null'));
  fs.writeFileSync(rutaManifiesto, JSON.stringify(man));

  const r = ent.instalar();
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Actualizar el registro models\.yaml \(no lo habías modificado/);
  const plantilla = leer(path.join(RAIZ, 'orquestador', 'models.yaml'));
  assert.equal(hashRegistro(leer(registro)), hashRegistro(plantilla), 'es la plantilla nueva');
  assert.match(leer(registro), /^ {2}skills_compatibles: true$/m, 'conserva la Fase 0');
  assert.match(leer(registro), /^ {2}salida_json: false$/m);
  assert.match(leer(registro), /^ {2}permitir_cuenta_personal: false$/m, 'conserva tus ajustes');
  assert.match(leer(registro), /^ {2}lectura_denegada: \["~\/trabajo"\]/m);
  assert.match(leer(registro), /^ {2}lectura_extra: \["~\/trabajo\/refs"\]/m);
  assert.equal(leer(`${registro}.anterior`), viejo);
  assert.ok(!fs.existsSync(`${registro}.nuevo`));

  // cambiar tus ajustes (permitir_cuenta_personal, lectura_denegada) no cuenta como modificarlo
  fs.writeFileSync(registro, leer(registro).replace('permitir_cuenta_personal: false', 'permitir_cuenta_personal: true'));
  assert.match(ent.instalar().salida, /Registro sin cambios/);
  assert.match(leer(registro), /^ {2}permitir_cuenta_personal: true$/m);

  // si lo editas después, la próxima instalación lo conserva
  fs.writeFileSync(registro, `${tuyo}\n# editado por el usuario\n`);
  const editado = leer(registro);
  const r2 = ent.instalar();
  assert.match(r2.salida, /Se conserva tu models\.yaml \(lo modificaste\)/);
  assert.equal(leer(registro), editado);
});

test('actualizar el registro conserva sandbox.lectura_denegada vacío, escritura_extra y preparar_con_credenciales', (t) => {
  const ent = crearEntorno(t);
  assert.equal(ent.instalar().codigo, 0);

  const rutaManifiesto = path.join(ent.dest, 'instalacion.json');
  const registro = path.join(ent.dest, 'models.yaml');
  const viejo = [
    '# registro de una versión anterior',
    'command_code:',
    '  bin: cmd',
    '  skills_compatibles: null',
    '  salida_json: null',
    'antigravity:',
    '  permitir_cuenta_personal: true',
    'sandbox:',
    '  escritura_extra: ["~/Library/Application Support/mi-app"]',
    '  lectura_denegada: []',
    '  lectura_extra: []',
    '  preparar_con_credenciales: true',
    'models: {}',
    '',
  ].join('\n');
  fs.writeFileSync(registro, viejo);
  const man = JSON.parse(leer(rutaManifiesto));
  man.registro = hashRegistro(viejo);
  fs.writeFileSync(rutaManifiesto, JSON.stringify(man));

  const r = ent.instalar();
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Actualizar el registro models\.yaml/);

  const actualizado = leer(registro);
  const plantilla = leer(path.join(RAIZ, 'orquestador', 'models.yaml'));
  assert.equal(hashRegistro(actualizado), hashRegistro(plantilla));
  assert.match(actualizado, /^ {2}lectura_denegada: \[\](?:\s+#.*)?$/m);
  assert.match(actualizado, /^ {2}escritura_extra: \["~\/Library\/Application Support\/mi-app"\](?:\s+#.*)?$/m);
  assert.match(actualizado, /^ {2}preparar_con_credenciales: true(?:\s+#.*)?$/m);

  // Reinstalar después con esos ajustes intactos sigue reconociendo el registro como sin cambios
  const r2 = ent.instalar();
  assert.equal(r2.codigo, 0, r2.salida);
  assert.match(r2.salida, /Registro sin cambios/);
  assert.match(leer(registro), /^ {2}lectura_denegada: \[\](?:\s+#.*)?$/m);
  assert.match(leer(registro), /^ {2}escritura_extra: \["~\/Library\/Application Support\/mi-app"\](?:\s+#.*)?$/m);
  assert.match(leer(registro), /^ {2}preparar_con_credenciales: true(?:\s+#.*)?$/m);
});

test('con settings.json inválido no toca nada, ni al instalar ni al desinstalar', (t) => {
  const ent = crearEntorno(t);
  assert.equal(ent.instalar().codigo, 0);

  const antesCodigo = leer(path.join(ent.dest, 'bin', 'orq.mjs'));
  fs.writeFileSync(ent.settingsRuta, '{ esto no es json');
  for (const args of [[], ['--desinstalar']]) {
    const r = ent.instalar(...args);
    assert.equal(r.codigo, 1, r.salida);
    assert.match(r.salida, /settings\.json no es JSON válido.*No se modificó nada/);
    assert.doesNotMatch(r.salida, /\n {4}at /, 'sin stack trace');
    assert.equal(leer(path.join(ent.dest, 'bin', 'orq.mjs')), antesCodigo);
    assert.ok(fs.existsSync(path.join(ent.dest, 'instalacion.json')));
    assert.ok(fs.existsSync(ent.shim));
  }
});

test('no pisa un orq ajeno sin --forzar', (t) => {
  const ent = crearEntorno(t);
  const ajeno = ent.mkdtemp('orq-bin-');
  fs.writeFileSync(path.join(ajeno, 'orq'), '#!/bin/sh\necho otro\n');
  const r = ent.instalarCon({ ORQ_BIN_DIR: ajeno }, '--simular');
  assert.equal(r.codigo, 1);
  assert.match(r.stderr, /no es del orquestador/);
});

test('desinstalar quita lo suyo, respalda y deja lo tuyo', (t) => {
  const ent = crearEntorno(t);
  assert.equal(ent.instalar().codigo, 0);

  fs.appendFileSync(path.join(ent.dest, 'models.yaml'), '\n# mi cambio\n');
  fs.mkdirSync(path.join(ent.dest, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ent.dest, 'logs', 'delegaciones.jsonl'), '{"tipo":"delegacion","id":"x"}\n');

  const r = ent.instalar('--desinstalar');
  assert.equal(r.codigo, 0, r.salida);
  assert.ok(!fs.existsSync(ent.dest));
  assert.ok(!fs.existsSync(ent.shim));
  assert.ok(!fs.existsSync(path.join(ent.claude, 'skills', 'orquestar')));
  assert.ok(!fs.existsSync(path.join(ent.claude, 'agents', 'implementador-sonnet.md')));

  const respaldo = fs.readdirSync(ent.claude).find((n) => n.startsWith('orquestador-respaldo-'));
  assert.ok(respaldo);
  assert.match(leer(path.join(ent.claude, respaldo, 'models.yaml')), /# mi cambio/);
  assert.ok(fs.existsSync(path.join(ent.claude, respaldo, 'logs', 'delegaciones.jsonl')));

  const s = ent.settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)', 'Bash(git status)']);
  assert.deepEqual(s.permissions.deny, []);
  assert.equal(leer(ent.zshrc).trim(), 'alias ll="ls -la"');
});

test('desinstalar sin instalacion.json quita el bloque de PATH, reglas de permisos y subagentes sin modificar', (t) => {
  const ent = crearEntorno(t, {
    settingsIniciales: {
      model: 'opus',
      permissions: {
        allow: ['Bash(npm test)', 'Bash(git status)'],
        deny: ['Bash(regla-propia *)'],
      },
    },
  });
  assert.equal(ent.instalar().codigo, 0);

  // Modifica un subagente para verificar que solo quita los no modificados
  fs.appendFileSync(path.join(ent.claude, 'agents', 'Explore.md'), '\nAjuste del usuario.\n');
  fs.rmSync(path.join(ent.dest, 'instalacion.json'));

  const r = ent.instalar('--desinstalar');
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /No encontré instalacion\.json/);
  assert.ok(!fs.existsSync(ent.dest));
  assert.ok(!fs.existsSync(ent.shim));
  assert.ok(!fs.existsSync(path.join(ent.claude, 'skills', 'orquestar')));

  for (const a of ['analista-sonnet', 'implementador-sonnet', 'documentador-haiku']) {
    assert.ok(!fs.existsSync(path.join(ent.claude, 'agents', `${a}.md`)), `debe quitar ${a}`);
  }
  assert.ok(fs.existsSync(path.join(ent.claude, 'agents', 'Explore.md')), 'conserva subagente modificado');
  assert.match(r.salida, /Se conserva el subagente Explore/);

  const s = ent.settings();
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)']);
  assert.deepEqual(s.permissions.deny, ['Bash(regla-propia *)']);
  assert.equal(leer(ent.zshrc).trim(), 'alias ll="ls -la"');

  // También limpia conf.d/orquestador.fish sin instalacion.json
  const entFish = crearEntorno(t, { shell: '/usr/bin/fish' });
  assert.equal(entFish.instalar().codigo, 0);
  assert.ok(fs.existsSync(entFish.fishConf));
  fs.rmSync(path.join(entFish.dest, 'instalacion.json'));
  const rFish = entFish.instalar('--desinstalar');
  assert.equal(rFish.codigo, 0, rFish.salida);
  assert.ok(!fs.existsSync(entFish.fishConf));
});

test('configura PATH en bash y actualiza el bloque cuando cambia ORQ_BIN_DIR', (t) => {
  const ent = crearEntorno(t, { shell: '/bin/bash' });
  fs.writeFileSync(ent.bashRc, 'export EDITOR=vim\n');

  const r1 = ent.instalar();
  assert.equal(r1.codigo, 0, r1.salida);
  assert.ok(fs.existsSync(ent.bashRc));
  const otroRc = path.join(ent.home, process.platform === 'darwin' ? '.bashrc' : '.bash_profile');
  assert.ok(!fs.existsSync(otroRc), 'solo escribe el archivo de bash de esta plataforma');
  assert.match(leer(ent.bashRc), /^export EDITOR=vim$/m);
  assert.match(leer(ent.bashRc), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);

  const binEspacios = path.join(ent.home, 'mis comandos', 'bin');
  const r2 = ent.instalarCon({ ORQ_BIN_DIR: binEspacios });
  assert.equal(r2.codigo, 0, r2.salida);
  assert.match(r2.salida, /Actualizar .* al PATH/);
  const contenido = leer(ent.bashRc);
  assert.equal(contenido.match(/>>> orquestador >>>/g).length, 1);
  assert.match(contenido, /^export EDITOR=vim$/m);
  assert.doesNotMatch(contenido, /\$HOME\/\.local\/bin/);
  assert.match(contenido, /export PATH="\$HOME\/mis comandos\/bin:\$PATH"/);

  const v = spawnSync(path.join(binEspacios, 'orq'), ['--version'], { env: ent.env(), encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test('configura PATH en fish con rutas con espacios y actualiza el bloque al cambiar ORQ_BIN_DIR', (t) => {
  const ent = crearEntorno(t, { shell: '/usr/bin/fish' });
  const bin1 = path.join(ent.home, 'bin con espacios');
  const r1 = ent.instalarCon({ ORQ_BIN_DIR: bin1 });
  assert.equal(r1.codigo, 0, r1.salida);
  assert.ok(fs.existsSync(ent.fishConf));
  assert.match(leer(ent.fishConf), /fish_add_path "\$HOME\/bin con espacios"/);
  const man = JSON.parse(leer(path.join(ent.dest, 'instalacion.json')));
  assert.deepEqual(man.shell, { tipo: 'fish', ruta: ent.fishConf });

  // Cambia ORQ_BIN_DIR a una ruta fuera de HOME también con espacios: actualiza sin duplicar el bloque
  const bin2 = path.join(ent.raiz, 'otro bin con espacios');
  const r2 = ent.instalarCon({ ORQ_BIN_DIR: bin2 });
  assert.equal(r2.codigo, 0, r2.salida);
  assert.match(r2.salida, /Actualizar .* al PATH/);
  const fishContenido = leer(ent.fishConf);
  assert.equal(fishContenido.match(/>>> orquestador >>>/g).length, 1);
  assert.doesNotMatch(fishContenido, /bin con espacios\n/);
  assert.ok(fishContenido.includes(`fish_add_path "${bin2}"`), fishContenido);

  const v = spawnSync(path.join(bin2, 'orq'), ['--version'], { env: ent.env(), encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test('instalar.sh limpia su directorio temporal al salir', (t) => {
  const ent = crearEntorno(t);
  const tmpSh = ent.mkdtemp('tmp-sh-');
  const stubBin = ent.mkdtemp('stub-bin-');
  const tarSrc = ent.mkdtemp('tar-src-');
  const tarball = path.join(ent.raiz, 'repo.tar.gz');
  const shLog = path.join(ent.raiz, 'sh.log');

  fs.mkdirSync(path.join(tarSrc, 'omg-main'), { recursive: true });
  fs.writeFileSync(path.join(tarSrc, 'omg-main', 'instalar.mjs'), 'console.log("stub");\n');
  execFileSync('tar', ['-czf', tarball, '-C', tarSrc, 'omg-main']);

  const stubCurl = path.join(stubBin, 'curl');
  fs.writeFileSync(stubCurl, [
    '#!/bin/sh',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '[ -n "$out" ] || exit 2',
    'cp "$ORQ_TEST_TARBALL" "$out"',
    '',
  ].join('\n'));
  fs.chmodSync(stubCurl, 0o755);

  const stubNode = path.join(stubBin, 'node');
  fs.writeFileSync(stubNode, [
    '#!/bin/sh',
    '{',
    '  printf "script=%s\\n" "$1"',
    '  printf "exists=%s\\n" "$([ -f "$1" ] && echo yes || echo no)"',
    '  shift',
    '  printf "args=%s\\n" "$*"',
    '} > "$ORQ_TEST_SH_LOG"',
    'exit "${ORQ_TEST_NODE_EXIT:-0}"',
    '',
  ].join('\n'));
  fs.chmodSync(stubNode, 0o755);

  const dirsCreados = [];
  t.after(() => {
    for (const d of dirsCreados) fs.rmSync(d, { recursive: true, force: true });
  });

  const baseEnv = {
    ...ent.env(),
    TMPDIR: tmpSh,
    PATH: [stubBin, '/usr/bin', '/bin'].join(':'),
    ORQ_TEST_TARBALL: tarball,
    ORQ_TEST_SH_LOG: shLog,
  };

  for (const [exitCode, args] of [['0', ['--simular']], ['1', ['--desinstalar']]]) {
    const r = spawnSync('/bin/sh', [INSTALAR_SH, ...args], {
      env: { ...baseEnv, ORQ_TEST_NODE_EXIT: exitCode },
      encoding: 'utf8',
    });
    assert.equal(r.status, Number(exitCode), `${r.stdout}${r.stderr}`);
    const log = Object.fromEntries(leer(shLog).trim().split('\n').map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    const tmpCreado = path.dirname(log.script);
    dirsCreados.push(tmpCreado);
    assert.ok(log.script.endsWith('/instalar.mjs'), log.script);
    assert.equal(log.exists, 'yes');
    assert.equal(log.args, args.join(' '));
    assert.ok(!fs.existsSync(tmpCreado), `debe borrar $TMP (${tmpCreado}) al salir`);
    assert.deepEqual(fs.readdirSync(tmpSh).filter((n) => n.startsWith('tmp.')), []);
  }
});

test('REGISTROS_PUBLICADOS en instalar.mjs incluye el hash actual de models.yaml', () => {
  const codigo = leer(INSTALAR);
  const match = codigo.match(/const REGISTROS_PUBLICADOS = \[([\s\S]*?)\];/);
  assert.ok(match, 'Debe declarar REGISTROS_PUBLICADOS en instalar.mjs');
  const publicados = [...match[1].matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
  const actual = hashRegistro(leer(path.join(RAIZ, 'orquestador', 'models.yaml')));
  assert.ok(publicados.includes(actual), `REGISTROS_PUBLICADOS no incluye el hash actual de models.yaml (${actual})`);
});
