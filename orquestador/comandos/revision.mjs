// orq revision <id> aprobado|ajustado|corregido [--nota "texto breve"]
//
// aprobado  -> el diff cumple el plan y los tests pasan.
// ajustado  -> se aprueba tras una corrección trivial que hizo Opus en el worktree (cuenta como aprobado).
// corregido -> no pasó la revisión y requiere un reintento o escalamiento.
//
// <id> es el id del intento que imprime el resumen de cada delegación. El id de una tarea es también el de
// su primer intento: se registra sobre ese intento, nunca sobre otro (una revisión tardía del intento 1 no
// pisa la del intento 2).

import { parseArgs } from 'node:util';
import { ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { rutasLogs } from '../lib/config.mjs';
import { agregarLinea, leerJsonl } from '../lib/util.mjs';
import { tareaDe } from '../lib/tareas.mjs';

const RESULTADOS = ['aprobado', 'ajustado', 'corregido'];

export async function ejecutar(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { nota: { type: 'string' } } });
  const [id, resultado] = positionals;
  if (!id || !RESULTADOS.includes(resultado) || positionals.length > 2) {
    throw new ErrorOrquestador('Uso: orq revision <id del intento> aprobado|ajustado|corregido [--nota "texto"]');
  }
  const logs = rutasLogs();
  const delegaciones = leerJsonl(logs.jsonl).filter((e) => e.tipo === 'delegacion');
  const delegacion = delegaciones.find((e) => e.id === id);
  if (!delegacion) throw new ErrorOrquestador(`No hay un intento con id "${id}". Usa el id que imprime el resumen de la delegación.`);

  const tarea = tareaDe(delegacion);
  const posteriores = delegaciones.filter((e) => tareaDe(e) === tarea && e.fecha > delegacion.fecha);
  agregarLinea(logs.jsonl, { tipo: 'revision', id, tarea, resultado, nota: values.nota ?? null, fecha: new Date().toISOString() });
  process.stdout.write(`Revisión registrada: ${id} (intento ${delegacion.intento} de la tarea ${tarea}) → ${resultado}.\n`);
  if (posteriores.length) {
    process.stdout.write(`Aviso: la tarea ya tiene ${posteriores.length} intento(s) posterior(es); esta revisión es solo del intento ${delegacion.intento}.\n`);
  }
  if (resultado === 'corregido' && !posteriores.length) {
    process.stdout.write(
      `Siguiente paso: orq delegar ${delegacion.rol} --continuar ${tarea} con un prompt de corrección acotado a las fallas ` +
        '(si ya era el último intento, orq indica a qué escalar).\n',
    );
  }
  return SALIDA.OK;
}
