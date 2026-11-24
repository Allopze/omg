// orq init [--sensible] [--forzar]
// Crea .claude/orquestador.yaml en el repo actual para ajustar roles o marcarlo como sensible.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cargarRegistro, ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import {
  ARCHIVO_REPO, PLANTILLA_AJUSTES_REPO, RUTA_REGISTRO, detectarSensible, registroEfectivo,
} from '../lib/config.mjs';
import { git, raizRepo } from '../lib/util.mjs';

export const AYUDA = [
  'Uso: orq init [--sensible] [--forzar]',
  '',
  'Crea .claude/orquestador.yaml en el repo actual para ajustar roles, declarar',
  'comandos preparar/validar o marcar el repo como sensible.',
  '',
  'Opciones:',
  '  --sensible  Marca el repo como sensible (sensible: true). Si ya existe',
  '              .claude/orquestador.yaml, actualiza solo ese campo sin perder tus ajustes.',
  '  --forzar    Sobrescribe .claude/orquestador.yaml con la plantilla limpia.',
  '  -h, --help  Muestra esta ayuda.',
  '',
].join('\n');

export async function ejecutar(argv = []) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sensible: { type: 'boolean', default: false },
      forzar: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(AYUDA);
    return SALIDA.OK;
  }

  const raiz = raizRepo();
  const ruta = path.join(raiz, ARCHIVO_REPO);
  const existe = fs.existsSync(ruta);
  if (existe && !values.forzar && !values.sensible) {
    throw new ErrorOrquestador(`Ya existe ${ARCHIVO_REPO}. Edítalo, usa --sensible para marcarlo sensible, o --forzar para reemplazarlo.`);
  }

  let sensibilidad;
  if (existe && values.sensible && !values.forzar) {
    const actual = fs.readFileSync(ruta, 'utf8');
    const reSensible = /^(sensible:)[ \t]*(?:[^\r\n#]*?)[ \t]*(#.*)?$/m;
    const actualizado = reSensible.test(actual)
      ? actual.replace(reSensible, (_, clave, com) => `${clave} true${com ? ` ${com}` : ''}`)
      : (actual.startsWith('---')
        ? actual.replace(/^---\r?\n?/, (m) => `${m.endsWith('\n') ? m : `${m}\n`}sensible: true\n`)
        : `sensible: true\n${actual}`);
    fs.writeFileSync(ruta, actualizado);
    try {
      ({ sensibilidad } = registroEfectivo(raiz));
    } catch (e) {
      fs.writeFileSync(ruta, actual);
      throw e;
    }
    process.stdout.write(`Actualizado ${ARCHIVO_REPO} (sensible: true; se conservan los demás ajustes).\n`);
  } else {
    const global = cargarRegistro(RUTA_REGISTRO);
    const sensibleGlobal = detectarSensible(global, raiz, null);
    const marcarSensible = values.sensible || sensibleGlobal.sensible;
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, PLANTILLA_AJUSTES_REPO.replace('__SENSIBLE__', String(marcarSensible)));
    ({ sensibilidad } = registroEfectivo(raiz));
    process.stdout.write(`Creado ${ARCHIVO_REPO}.\n`);
    if (!values.sensible && sensibleGlobal.sensible) {
      process.stdout.write(
        `El registro global ya detecta este repo como sensible (${sensibleGlobal.motivos.join('; ')}): inicializado con sensible: true.\n`,
      );
    }
  }

  process.stdout.write(sensibilidad.sensible
    ? `Repo sensible (${sensibilidad.motivos.join('; ')}): Command Code queda bloqueado aquí.\n`
    : 'Repo no sensible.\n');
  const ignorado = git(['check-ignore', '-q', ARCHIVO_REPO], raiz, { permitirFallo: true }) !== null;
  if (ignorado) {
    process.stdout.write(
      `Aviso: ${ARCHIVO_REPO} está ignorado por git (.gitignore o exclude); no se incluirá en commits para el equipo.\n`,
    );
  } else {
    process.stdout.write(`Haz commit del archivo para que aplique a todo el equipo: git add ${ARCHIVO_REPO}\n`);
  }
  return SALIDA.OK;
}
