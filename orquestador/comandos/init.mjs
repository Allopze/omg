// orq init [--sensible] [--forzar]
// Crea .claude/orquestador.yaml en el repo actual para ajustar roles o marcarlo como sensible.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { ARCHIVO_REPO, PLANTILLA_AJUSTES_REPO, registroEfectivo } from '../lib/config.mjs';
import { raizRepo } from '../lib/util.mjs';

export async function ejecutar(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { sensible: { type: 'boolean', default: false }, forzar: { type: 'boolean', default: false } },
  });
  const raiz = raizRepo();
  const ruta = path.join(raiz, ARCHIVO_REPO);
  if (fs.existsSync(ruta) && !values.forzar) {
    throw new ErrorOrquestador(`Ya existe ${ARCHIVO_REPO}. Edítalo, o usa --forzar para reemplazarlo.`);
  }
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, PLANTILLA_AJUSTES_REPO.replace('__SENSIBLE__', String(values.sensible)));
  const { sensibilidad } = registroEfectivo(raiz);
  process.stdout.write(`Creado ${ARCHIVO_REPO}.\n`);
  process.stdout.write(sensibilidad.sensible
    ? `Repo sensible (${sensibilidad.motivos.join('; ')}): Command Code queda bloqueado aquí.\n`
    : 'Repo no sensible.\n');
  process.stdout.write(`Haz commit del archivo para que aplique a todo el equipo: git add ${ARCHIVO_REPO}\n`);
  return SALIDA.OK;
}
