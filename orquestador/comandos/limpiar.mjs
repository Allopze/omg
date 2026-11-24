// orq limpiar [--descartar <id|ruta>] [--simular]
// Elimina worktrees y ramas de delegaciones ya integradas en HEAD (las que no tienen commits no cuentan).
// Con --descartar, elimina una delegación sin integrar (pierde sus cambios) y marca su tarea como descartada.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { rutasLogs } from '../lib/config.mjs';
import { git, raizRepo, agregarLinea } from '../lib/util.mjs';
import { worktreesDelegacion } from '../lib/worktrees.mjs';

export async function ejecutar(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { descartar: { type: 'string' }, simular: { type: 'boolean', default: false } },
  });
  const raiz = raizRepo();
  const wts = worktreesDelegacion(raiz);
  const accion = values.simular ? 'Se eliminaría' : 'Eliminado';

  if (values.descartar) {
    const objetivo = wts.find((w) => [w.id, w.rama, w.ruta, w.relativa].includes(values.descartar));
    if (!objetivo) throw new ErrorOrquestador(`No hay un worktree de delegación "${values.descartar}". Mira la lista con orq estado.`);
    if (!values.simular) {
      git(['worktree', 'remove', '--force', objetivo.ruta], raiz);
      git(['branch', '-D', objetivo.rama], raiz);
      // La tarea deja de figurar como abierta en orq estado y en el scorecard.
      agregarLinea(rutasLogs().jsonl, {
        tipo: 'descarte', tarea: objetivo.id, repo: path.basename(raiz), raiz, fecha: new Date().toISOString(),
      });
    }
    process.stdout.write(`${accion} sin integrar: ${objetivo.relativa} (${objetivo.rama}).\n`);
    return SALIDA.OK;
  }

  const integradas = wts.filter((w) => w.integrada);
  const errores = [];
  for (const w of integradas) {
    if (values.simular) {
      process.stdout.write(`${accion}: ${w.relativa} (${w.rama})\n`);
      continue;
    }
    if (git(['worktree', 'remove', w.ruta], raiz, { permitirFallo: true }) === null) {
      errores.push(`${w.relativa}: tiene cambios sin commit; revísalo o usa --descartar ${w.id}`);
      continue;
    }
    git(['branch', '-d', w.rama], raiz, { permitirFallo: true });
    process.stdout.write(`${accion}: ${w.relativa} (${w.rama})\n`);
  }
  if (!values.simular) git(['worktree', 'prune'], raiz, { permitirFallo: true });
  const pendientes = wts.length - integradas.length;
  process.stdout.write(`${integradas.length - errores.length} limpiado(s); ${pendientes} sin integrar se mantienen.\n`);
  if (errores.length) process.stderr.write(`No se pudo limpiar:\n- ${errores.join('\n- ')}\n`);
  return errores.length ? 1 : SALIDA.OK;
}
