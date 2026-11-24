import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globARegex, registroEfectivo, expandirHome, dirWorktrees } from '../lib/config.mjs';

const MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.yaml');

function entorno({ rutas = [], remotos = [], ajustes = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-config-'));
  const repo = path.join(dir, 'mi-repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const yaml = fs.readFileSync(MODELS, 'utf8')
    .replace('rutas: []', `rutas: ${JSON.stringify(rutas)}`)
    .replace('remotos: []', `remotos: ${JSON.stringify(remotos)}`);
  const registro = path.join(dir, 'models.yaml');
  fs.writeFileSync(registro, yaml);
  if (ajustes !== null) {
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'orquestador.yaml'), ajustes);
  }
  return { repo, registro };
}

test('globARegex soporta *, ? y ~', () => {
  assert.ok(globARegex('*privado*').test('git@github.com:usuario/Privado.git'));
  assert.ok(globARegex('repo-?').test('repo-1'));
  assert.ok(!globARegex('repo-?').test('repo-10'));
  assert.ok(globARegex('~/dev/*').test(path.join(os.homedir(), 'dev', 'x')));
  assert.equal(expandirHome('~/a'), path.join(os.homedir(), 'a'));
});

test('sin ajustes ni patrones: valores globales y no sensible', () => {
  const e = entorno();
  const { registro, ajustes, sensibilidad } = registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: [] });
  assert.equal(ajustes, null);
  assert.equal(sensibilidad.sensible, false);
  assert.equal(registro.repo.sensible, false);
  assert.equal(registro.roles.implementar.effort, 'high');
});

test('detecta repos sensibles por remoto y por ruta', () => {
  const e = entorno({ remotos: ['*privado*'] });
  const r = registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: ['git@github.com:x/privado.git'] });
  assert.equal(r.sensibilidad.sensible, true);
  assert.match(r.sensibilidad.motivos[0], /remoto/);

  const e2 = entorno({ rutas: ['*/mi-repo'] });
  assert.equal(registroEfectivo(e2.repo, { rutaRegistro: e2.registro, remotos: [] }).sensibilidad.sensible, true);
});

test('el repo puede marcarse sensible pero no desmarcarse', () => {
  const e = entorno({ ajustes: 'sensible: true\n' });
  assert.equal(registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: [] }).registro.repo.sensible, true);

  const e2 = entorno({ remotos: ['*privado*'], ajustes: 'sensible: false\n' });
  const r = registroEfectivo(e2.repo, { rutaRegistro: e2.registro, remotos: ['https://x/privado'] });
  assert.equal(r.sensibilidad.sensible, true);
  assert.equal(r.sensibilidad.intentoDesmarcar, true);
});

test('aplica ajustes de roles permitidos', () => {
  const e = entorno({ ajustes: 'roles:\n  implementar:\n    effort: max\n    max_archivos: 40\n    skills: [.claude/skills/x]\n' });
  const { registro } = registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: [] });
  assert.equal(registro.roles.implementar.effort, 'max');
  assert.equal(registro.roles.implementar.max_archivos, 40);
  assert.deepEqual(registro.roles.implementar.skills, ['.claude/skills/x']);
  assert.equal(registro.roles.tests.effort, 'low');
});

test('rechaza ajustes que tocan la whitelist o campos no ajustables', () => {
  for (const ajustes of [
    'models:\n  otro/modelo: {}\n',
    'roles:\n  implementar:\n    permitidos: [otro/modelo]\n',
    'roles:\n  implementar:\n    yolo: false\n',
    'roles:\n  inventado:\n    effort: low\n',
    'sensible: quizas\n',
  ]) {
    const e = entorno({ ajustes });
    assert.throws(() => registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: [] }), /orquestador\.yaml inválido/, ajustes);
  }
});

test('preparar, validar y desactivado se leen del repo y se validan', () => {
  const e = entorno({ ajustes: 'desactivado: true\npreparar: [npm ci]\nvalidar:\n  - npm test\n  - npm run lint\n' });
  const { repo } = registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: [] });
  assert.deepEqual(repo, { desactivado: true, preparar: ['npm ci'], validar: ['npm test', 'npm run lint'] });

  const sin = entorno({ ajustes: 'sensible: false\n' });
  assert.deepEqual(registroEfectivo(sin.repo, { rutaRegistro: sin.registro, remotos: [] }).repo, { desactivado: false, preparar: [], validar: [] });

  for (const ajustes of ['preparar: npm ci\n', 'validar: [1]\n', 'desactivado: tal-vez\n', 'command_code:\n  sandbox: {modo: desactivado}\n']) {
    const x = entorno({ ajustes });
    assert.throws(() => registroEfectivo(x.repo, { rutaRegistro: x.registro, remotos: [] }), /orquestador\.yaml inválido/, ajustes);
  }
});

test('dirWorktrees: dentro del repo por defecto o en una carpeta externa por repo', () => {
  assert.equal(dirWorktrees({}, '/dev/app'), path.join('/dev/app', '.claude', 'worktrees'));
  const externa = dirWorktrees({ worktrees: { ubicacion: 'externa', dir_externo: '~/wts' } }, '/dev/app');
  assert.match(externa, new RegExp(`^${path.join(os.homedir(), 'wts')}/app-[0-9a-f]{8}$`));
  assert.notEqual(externa, dirWorktrees({ worktrees: { ubicacion: 'externa', dir_externo: '~/wts' } }, '/otro/app'));
});

test('rechaza ajustes que dejan el registro inválido', () => {
  const e = entorno({ ajustes: 'roles:\n  implementar:\n    effort: medium\n' });
  assert.throws(() => registroEfectivo(e.repo, { rutaRegistro: e.registro, remotos: [] }), /dejan el registro inválido/);
});
