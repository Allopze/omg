// Prueba el instalador global en un HOME temporal. Ejecutar con: node --test pruebas/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashRegistro } from '../orquestador/lib/registro-texto.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALAR = path.join(RAIZ, 'instalar.mjs');
const CMD_FALSO = path.join(RAIZ, 'orquestador', 'test', 'fixtures', 'cmd-falso.mjs');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-home-'));
const CLAUDE = path.join(HOME, '.claude');
const DEST = path.join(CLAUDE, 'orquestador');
const SHIM = path.join(HOME, '.local', 'bin', 'orq');
const ZSHRC = path.join(HOME, '.zshrc');
const SETTINGS = path.join(CLAUDE, 'settings.json');

const env = () => {
  const e = {
    ...process.env,
    HOME,
    SHELL: '/bin/zsh',
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    ORQ_CMD_BIN: CMD_FALSO,
    ORQ_AGY_BIN: path.join(RAIZ, 'orquestador', 'test', 'fixtures', 'agy-falso.mjs'),
    npm_config_cache: path.join(os.tmpdir(), 'orq-npm-cache'),
  };
  delete e.CLAUDE_CONFIG_DIR;
  delete e.ZDOTDIR;
  delete e.ORQ_HOME;
  delete e.ORQ_BIN_DIR;
  return e;
};
const instalarCon = (extra, ...args) => {
  const r = spawnSync(process.execPath, [INSTALAR, ...args], { env: { ...env(), ...extra }, encoding: 'utf8' });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
};
const instalar = (...args) => instalarCon({}, ...args);
const leer = (p) => fs.readFileSync(p, 'utf8');
const settings = () => JSON.parse(leer(SETTINGS));

fs.mkdirSync(CLAUDE, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)', 'Bash(git status)'] } }));
fs.writeFileSync(ZSHRC, 'alias ll="ls -la"\n');

test('simular no modifica nada', () => {
  const antes = leer(SETTINGS);
  const r = instalar('--simular');
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Simulación terminada/);
  assert.equal(leer(SETTINGS), antes);
  assert.ok(!fs.existsSync(DEST));
  assert.ok(!fs.existsSync(SHIM));
});

test('instala todo a nivel de usuario', () => {
  const r = instalar();
  assert.equal(r.codigo, 0, r.salida);
  for (const p of ['bin/orq.mjs', 'lib/shims-macos/xcodebuild', 'lib/shims-macos/swift', 'models.yaml', 'node_modules/yaml', 'instalacion.json', 'VERSION']) {
    assert.ok(fs.existsSync(path.join(DEST, p)), p);
  }
  assert.ok((fs.statSync(path.join(DEST, 'lib', 'shims-macos', 'xcodebuild')).mode & 0o111) !== 0, 'xcodebuild shim ejecutable');
  assert.ok((fs.statSync(path.join(DEST, 'lib', 'shims-macos', 'swift')).mode & 0o111) !== 0, 'swift shim ejecutable');
  assert.ok(fs.existsSync(path.join(CLAUDE, 'skills', 'orquestar', 'SKILL.md')));
  for (const a of ['Explore', 'analista-sonnet', 'implementador-sonnet', 'documentador-haiku']) {
    assert.ok(fs.existsSync(path.join(CLAUDE, 'agents', `${a}.md`)), a);
  }
  const skill = leer(path.join(CLAUDE, 'skills', 'orquestar', 'SKILL.md'));
  assert.match(skill, /orq estado/);
  assert.doesNotMatch(skill, /ENRUTAMIENTO/);
  for (const p of ['test', '.instalando', '.anterior', 'comandos/generar-skill.mjs']) {
    assert.ok(!fs.existsSync(path.join(DEST, p)), `no instala ${p}`);
  }

  const s = settings();
  assert.equal(s.model, 'opus');
  assert.ok(s.permissions.allow.includes('Bash(npm test)'));
  assert.equal(s.permissions.allow.filter((x) => x === 'Bash(git status)').length, 1);
  assert.ok(s.permissions.allow.includes('Bash(orq delegar *)'));
  assert.ok(s.permissions.deny.includes(`Edit(/${DEST}/**)`));
  assert.ok(fs.existsSync(`${SETTINGS}.bak-orquestador`));

  const man = JSON.parse(leer(path.join(DEST, 'instalacion.json')));
  assert.ok(!man.reglas.allow.includes('Bash(git status)'), 'no se apropia de reglas que ya eran tuyas');

  assert.match(leer(ZSHRC), /alias ll/);
  assert.match(leer(ZSHRC), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);

  const v = spawnSync(SHIM, ['--version'], { env: env(), encoding: 'utf8' });
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  assert.match(r.salida, /Todo en orden|problema/);
});

test('reinstalar es idempotente y conserva tus cambios', () => {
  fs.appendFileSync(path.join(DEST, 'models.yaml'), '\n# mi cambio\n');
  fs.appendFileSync(path.join(CLAUDE, 'agents', 'Explore.md'), '\nMi ajuste.\n');
  fs.mkdirSync(path.join(DEST, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(DEST, 'logs', 'delegaciones.jsonl'), '{"tipo":"delegacion","id":"x"}\n');
  // restos de una instalación 0.2: test/ y el comando generar-skill
  fs.mkdirSync(path.join(DEST, 'test'), { recursive: true });
  fs.writeFileSync(path.join(DEST, 'test', 'viejo.test.mjs'), '');
  fs.writeFileSync(path.join(DEST, 'comandos', 'generar-skill.mjs'), '');

  const r = instalar();
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Actualizando el orquestador/);
  assert.ok(!fs.existsSync(path.join(DEST, 'test')));
  assert.ok(!fs.existsSync(path.join(DEST, 'comandos', 'generar-skill.mjs')));
  assert.match(leer(path.join(DEST, 'models.yaml')), /# mi cambio/);
  assert.ok(fs.existsSync(path.join(DEST, 'models.yaml.nuevo')));
  assert.match(leer(path.join(CLAUDE, 'agents', 'Explore.md')), /Mi ajuste/);
  assert.match(r.salida, /Se conserva tu subagente Explore/);
  assert.ok(fs.existsSync(path.join(DEST, 'logs', 'delegaciones.jsonl')));
  assert.equal(leer(ZSHRC).match(/>>> orquestador >>>/g).length, 1);
  const allow = settings().permissions.allow;
  assert.equal(allow.length, new Set(allow).size);

  const f = instalar('--forzar');
  assert.equal(f.codigo, 0, f.salida);
  assert.doesNotMatch(leer(path.join(CLAUDE, 'agents', 'Explore.md')), /Mi ajuste/);
});

test('si npm ci falla, la instalación anterior queda intacta', () => {
  const antes = leer(path.join(DEST, 'bin', 'orq.mjs'));
  const r = instalarCon({
    npm_config_cache: fs.mkdtempSync(path.join(os.tmpdir(), 'orq-npm-vacio-')),
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_fetch_retries: '0',
    npm_config_offline: 'false',
  });
  assert.equal(r.codigo, 1, r.salida);
  assert.match(r.salida, /la instalación anterior quedó intacta/);
  assert.equal(leer(path.join(DEST, 'bin', 'orq.mjs')), antes);
  assert.ok(fs.existsSync(path.join(DEST, 'node_modules', 'yaml')));
  assert.ok(!fs.existsSync(path.join(DEST, '.instalando')));
  const v = spawnSync(SHIM, ['--version'], { env: env(), encoding: 'utf8' });
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test('actualiza el registro si no lo modificaste desde que lo instaló', () => {
  const rutaManifiesto = path.join(DEST, 'instalacion.json');
  const registro = path.join(DEST, 'models.yaml');
  const tuyo = leer(registro);
  // simula un registro que instaló una versión anterior y que nunca editaste
  // con resultados de la Fase 0 (orq verificar --guardar), que no cuentan como modificación y se conservan
  const viejo = '# registro de una versión anterior\ncommand_code:\n  bin: cmd\n  skills_compatibles: true\n  salida_json: false\n' +
    'antigravity:\n  permitir_cuenta_personal: false\nsandbox:\n  lectura_denegada: ["~/trabajo"]\n  lectura_extra: ["~/trabajo/refs"]\nmodels: {}\n';
  fs.writeFileSync(registro, viejo);
  const man = JSON.parse(leer(rutaManifiesto));
  man.registro = hashRegistro(viejo.replace('skills_compatibles: true', 'skills_compatibles: null'));
  fs.writeFileSync(rutaManifiesto, JSON.stringify(man));

  const r = instalar();
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
  assert.match(instalar().salida, /Registro sin cambios/);
  assert.match(leer(registro), /^ {2}permitir_cuenta_personal: true$/m);

  // si lo editas después, la próxima instalación lo conserva
  fs.writeFileSync(registro, tuyo);
  const r2 = instalar();
  assert.match(r2.salida, /Se conserva tu models\.yaml \(lo modificaste\)/);
  assert.equal(leer(registro), tuyo);
});

test('con settings.json inválido no toca nada, ni al instalar ni al desinstalar', () => {
  const bueno = leer(SETTINGS);
  const antesCodigo = leer(path.join(DEST, 'bin', 'orq.mjs'));
  fs.writeFileSync(SETTINGS, '{ esto no es json');
  for (const args of [[], ['--desinstalar']]) {
    const r = instalar(...args);
    assert.equal(r.codigo, 1, r.salida);
    assert.match(r.salida, /settings\.json no es JSON válido.*No se modificó nada/);
    assert.doesNotMatch(r.salida, /\n {4}at /, 'sin stack trace');
    assert.equal(leer(path.join(DEST, 'bin', 'orq.mjs')), antesCodigo);
    assert.ok(fs.existsSync(path.join(DEST, 'instalacion.json')));
    assert.ok(fs.existsSync(SHIM));
  }
  fs.writeFileSync(SETTINGS, bueno);
});

test('no pisa un orq ajeno sin --forzar', () => {
  const ajeno = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-bin-'));
  fs.writeFileSync(path.join(ajeno, 'orq'), '#!/bin/sh\necho otro\n');
  const r = spawnSync(process.execPath, [INSTALAR, '--simular'], { env: { ...env(), ORQ_BIN_DIR: ajeno }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no es del orquestador/);
});

test('desinstalar quita lo suyo, respalda y deja lo tuyo', () => {
  const r = instalar('--desinstalar');
  assert.equal(r.codigo, 0, r.salida);
  assert.ok(!fs.existsSync(DEST));
  assert.ok(!fs.existsSync(SHIM));
  assert.ok(!fs.existsSync(path.join(CLAUDE, 'skills', 'orquestar')));
  assert.ok(!fs.existsSync(path.join(CLAUDE, 'agents', 'implementador-sonnet.md')));

  const respaldo = fs.readdirSync(CLAUDE).find((n) => n.startsWith('orquestador-respaldo-'));
  assert.ok(respaldo);
  assert.match(leer(path.join(CLAUDE, respaldo, 'models.yaml')), /# mi cambio/);
  assert.ok(fs.existsSync(path.join(CLAUDE, respaldo, 'logs', 'delegaciones.jsonl')));

  const s = settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)', 'Bash(git status)']);
  assert.deepEqual(s.permissions.deny, []);
  assert.equal(leer(ZSHRC).trim(), 'alias ll="ls -la"');
});
