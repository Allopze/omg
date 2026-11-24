#!/usr/bin/env node
// orq: orquestador multimodelo. Claude Code planifica; Command Code o Antigravity ejecutan (instalación global).

import { ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { leerVersion } from '../lib/constantes.mjs';

const COMANDOS = {
  delegar: 'Delega una tarea al modelo del rol (Command Code o Antigravity); uso principal de Opus.',
  revision: 'Registra el resultado de revisar un intento: aprobado | ajustado | corregido.',
  validar: 'Corre tests o comandos en el worktree de una tarea, dentro del sandbox (sin tus permisos).',
  ver: 'Muestra detalle, prompt, log y comando diff de una tarea o intento.',
  estado: 'Configuración efectiva del repo: roles, sandbox, tareas abiertas y worktrees.',
  init: 'Crea .claude/orquestador.yaml en el repo actual (--sensible para marcarlo).',
  limpiar: 'Elimina worktrees de delegaciones ya integradas (--descartar <id> para uno sin integrar).',
  scorecard: 'Métricas por delegación y por tarea (aprobación, validación, tokens), con sugerencias.',
  verificar: 'Fase 0: comprueba los ejecutores y el sandbox contra el registro (--sin-llamadas, --guardar, --modelo).',
  doctor: 'Diagnostica la instalación y el repo actual.',
};

function ayuda() {
  const ancho = Math.max(...Object.keys(COMANDOS).map((c) => c.length));
  return [
    `orq ${leerVersion()} · Claude Code planifica; Command Code o Antigravity ejecutan en un sandbox`,
    '',
    'Uso: orq <comando> [opciones]',
    '',
    ...Object.entries(COMANDOS).map(([c, d]) => `  ${c.padEnd(ancho)}  ${d}`),
    '',
    'Ayuda por comando: orq ayuda <comando> · orq <comando> --help',
    '',
    'Ejemplo:',
    "  orq delegar implementar --fase \"Fase 1\" <<'PROMPT'",
    '  ...prompt autocontenido...',
    '  PROMPT',
    "  orq delegar implementar --continuar <tarea> <<'PROMPT'   # reintento",
    '  ...corrección acotada...',
    '  PROMPT',
    '  orq validar <tarea> -- npm test                          # tests en el sandbox',
    '',
    'Códigos de salida: 0 ok · 1 falló · 2 uso · 3 bloqueado · 4 escalar · 5 integridad · 124 timeout · 130/143 señal',
    '',
  ].join('\n');
}

function traducirParseArgs(e, comando) {
  const m = String(e.message ?? '');
  let texto = m;
  let match;
  if ((match = m.match(/^Unknown option '([^']+)'/))) {
    texto = `Opción desconocida: ${match[1]}.`;
  } else if ((match = m.match(/^Option '([^']+)' argument missing/))) {
    texto = `Falta el valor de la opción ${match[1].replace(/ <value>$/, '')}.`;
  } else if ((match = m.match(/^Option '([^']+)' does not take an argument/))) {
    texto = `La opción ${match[1]} no admite valor.`;
  } else if ((match = m.match(/^Unexpected argument '([^']+)'/))) {
    texto = `Argumento inesperado "${match[1]}": este comando no recibe argumentos posicionales.`;
  }
  return `${texto} Usa: orq ${comando} --help`;
}

const [comando, ...resto] = process.argv.slice(2);

if (!comando || ['-h', '--help'].includes(comando) || (comando === 'ayuda' && !resto[0])) {
  process.stdout.write(ayuda());
  process.exit(SALIDA.OK);
}
if (['-v', '--version', 'version'].includes(comando)) {
  process.stdout.write(`${leerVersion()}\n`);
  process.exit(SALIDA.OK);
}
if (comando === 'ayuda') {
  const objetivo = resto[0];
  if (!Object.hasOwn(COMANDOS, objetivo)) {
    process.stderr.write(`Comando desconocido: ${objetivo}\n\n${ayuda()}`);
    process.exit(SALIDA.ERROR_USO);
  }
  const modulo = await import(`../comandos/${objetivo}.mjs`);
  if (typeof modulo.AYUDA === 'string') {
    process.stdout.write(modulo.AYUDA.endsWith('\n') ? modulo.AYUDA : `${modulo.AYUDA}\n`);
    process.exit(SALIDA.OK);
  }
  const codigo = await modulo.ejecutar(['--help']);
  process.exit(codigo ?? SALIDA.OK);
}
if (!Object.hasOwn(COMANDOS, comando)) {
  process.stderr.write(`Comando desconocido: ${comando}\n\n${ayuda()}`);
  process.exit(SALIDA.ERROR_USO);
}

try {
  const modulo = await import(`../comandos/${comando}.mjs`);
  const codigo = await modulo.ejecutar(resto);
  process.exit(codigo ?? SALIDA.OK);
} catch (e) {
  if (e instanceof ErrorOrquestador) {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.codigo);
  }
  if (e?.code?.startsWith?.('ERR_PARSE_ARGS')) {
    process.stderr.write(`${traducirParseArgs(e, comando)}\n`);
    process.exit(SALIDA.ERROR_USO);
  }
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
}
