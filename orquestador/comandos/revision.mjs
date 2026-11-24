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
import { tareaDe, esAprobado } from '../lib/tareas.mjs';

export const AYUDA = [
  'Uso: orq revision <id del intento> aprobado|ajustado|corregido [--nota "texto"]',
  '',
  'Registra el resultado de revisar un intento de delegación.',
  '',
  'Resultados:',
  '  aprobado   El diff cumple el plan y los tests pasan',
  '  ajustado   Aprobado tras una corrección trivial en el worktree (cuenta como aprobado)',
  '  corregido  No pasó la revisión y requiere un reintento o escalamiento',
  '',
  'Opciones:',
  '  --nota <texto>  Nota breve sobre la revisión',
  '  -h, --help      Muestra esta ayuda',
  '',
].join('\n');

const RESULTADOS = ['aprobado', 'ajustado', 'corregido'];

export async function ejecutar(argv = []) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      nota: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(AYUDA);
    return SALIDA.OK;
  }
  const [id, resultado] = positionals;
  if (!id || !RESULTADOS.includes(resultado) || positionals.length > 2) {
    throw new ErrorOrquestador('Uso: orq revision <id del intento> aprobado|ajustado|corregido [--nota "texto"]');
  }

  const logs = rutasLogs();
  const eventos = leerJsonl(logs.jsonl);
  const delegaciones = eventos.filter((e) => e?.tipo === 'delegacion');
  const delegacion = delegaciones.find((e) => e.id === id);
  if (!delegacion) throw new ErrorOrquestador(`No hay un intento con id "${id}". Usa el id que imprime el resumen de la delegación.`);

  const revisionPrevia = eventos.filter((e) => e?.tipo === 'revision' && e.id === id).at(-1) ?? null;
  const avisos = [];
  if (revisionPrevia) {
    avisos.push(`Aviso: el intento ${id} ya tenía una revisión previa (${revisionPrevia.resultado}); esta nueva revisión la reemplaza.`);
  }
  if (esAprobado(resultado)) {
    const motivos = [];
    if (delegacion.exit_code != null && delegacion.exit_code !== 0) motivos.push(`exit_code ${delegacion.exit_code}`);
    if (delegacion.criticas?.length > 0) motivos.push(`${delegacion.criticas.length} alerta(s) crítica(s) de integridad`);
    if (motivos.length) {
      avisos.push(`Aviso: estás marcando como ${resultado} un intento con ${motivos.join(' y ')}.`);
    }
  }

  const tarea = tareaDe(delegacion);
  const posteriores = delegaciones.filter((e) => tareaDe(e) === tarea && e.fecha > delegacion.fecha);
  agregarLinea(logs.jsonl, { tipo: 'revision', id, tarea, resultado, nota: values.nota ?? null, fecha: new Date().toISOString() });

  process.stdout.write(`Revisión registrada: ${id} (intento ${delegacion.intento} de la tarea ${tarea}) → ${resultado}.\n`);
  if (posteriores.length) {
    process.stdout.write(`Aviso: la tarea ya tiene ${posteriores.length} intento(s) posterior(es); esta revisión es solo del intento ${delegacion.intento}.\n`);
  }
  for (const av of avisos) process.stdout.write(`${av}\n`);
  if (resultado === 'corregido' && !posteriores.length) {
    process.stdout.write(
      `Siguiente paso: orq delegar ${delegacion.rol} --continuar ${tarea} con un prompt de corrección acotado a las fallas ` +
        '(si ya era el último intento, orq indica a qué escalar).\n',
    );
  }
  return SALIDA.OK;
}
