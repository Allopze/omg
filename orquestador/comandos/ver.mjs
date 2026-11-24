// orq ver <id|tarea> [--log] [--prompt] [--json]
// Muestra el detalle, la tabla de intentos, rutas, diff y opcionalmente el prompt o la cola del log.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ErrorOrquestador, SALIDA, tokensTotales } from '../lib/registro.mjs';
import { rutasLogs } from '../lib/config.mjs';
import { git, raizRepo, leerJsonl, ultimasLineas } from '../lib/util.mjs';
import { buscarTarea, resumirTareas } from '../lib/tareas.mjs';
import { worktreesDelegacion } from '../lib/worktrees.mjs';
import { leerMeta } from '../lib/worktree-tarea.mjs';

export const AYUDA = [
  'Uso: orq ver <id|tarea> [opciones]',
  '',
  'Muestra el detalle de una tarea o intento de delegación: estado, tabla de intentos,',
  'worktree/rama, comando diff, rutas de prompt/log y alertas o críticas.',
  '',
  'Opciones:',
  '  --prompt      Imprime el contenido completo del prompt enviado en el intento',
  '  --log         Imprime las últimas 40 líneas del log de salida del intento',
  '  --json        Devuelve la información en formato JSON',
  '  -h, --help    Muestra esta ayuda',
  '',
].join('\n');

function tabla(cab, filas) {
  const anchos = cab.map((c, i) => Math.max(c.length, ...filas.map((f) => f[i].length)));
  const linea = (cols) => `  ${cols.map((c, i) => c.padEnd(anchos[i])).join('  ')}`.trimEnd();
  return [linea(cab), `  ${anchos.map((a) => '-'.repeat(a)).join('  ')}`, ...filas.map(linea)];
}

function mapaRevisionesDetalle(eventos) {
  const mapa = new Map();
  for (const e of eventos) {
    if (e && typeof e === 'object' && e.tipo === 'revision' && typeof e.id === 'string') {
      mapa.set(e.id, { resultado: e.resultado, nota: e.nota ?? null, fecha: e.fecha ?? null });
    }
  }
  return mapa;
}

function leerTextoSeguro(ruta) {
  if (!ruta || !fs.existsSync(ruta)) return null;
  try {
    return fs.readFileSync(ruta, 'utf8');
  } catch {
    return null;
  }
}

export async function ejecutar(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      log: { type: 'boolean', default: false },
      prompt: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(AYUDA);
    return SALIDA.OK;
  }
  if (positionals.length !== 1) {
    throw new ErrorOrquestador('Uso: orq ver <id|tarea> [--log] [--prompt] [--json]');
  }

  const raiz = raizRepo();
  const logs = rutasLogs();
  const eventos = leerJsonl(logs.jsonl);
  const valor = positionals[0];
  const encontrada = buscarTarea(eventos, raiz, valor);
  if (!encontrada) {
    throw new ErrorOrquestador(`No hay una tarea o intento "${valor}" en este repo. orq estado lista las tareas abiertas.`);
  }

  const resumen = resumirTareas(eventos).find((t) => t.tarea === encontrada.tarea && t.raiz === raiz) ?? null;
  const revisiones = mapaRevisionesDetalle(eventos);
  const intentoObjetivo = (valor !== encontrada.tarea && encontrada.intentos.find((e) => e.id === valor)) || encontrada.ultima;

  const meta = leerMeta(logs, encontrada.tarea);
  const rama = encontrada.ultima?.rama ?? meta?.rama ?? (encontrada.ultima?.worktree ? `delegar/${encontrada.tarea}` : null);
  const wt = rama ? (worktreesDelegacion(raiz).find((w) => w.rama === rama) ?? null) : null;
  const base = meta?.base ?? encontrada.primera?.base ?? null;
  const ramaExiste = rama ? git(['rev-parse', '--verify', rama], raiz, { permitirFallo: true }) !== null : false;
  const comandoDiff = base && rama && ramaExiste ? `git diff ${base.slice(0, 12)}...${rama}` : null;

  const promptTexto = values.prompt ? leerTextoSeguro(intentoObjetivo.prompt) : undefined;
  const salidaTexto = values.log ? leerTextoSeguro(intentoObjetivo.salida) : undefined;
  const logCola = values.log ? (salidaTexto !== null ? ultimasLineas(salidaTexto, 40) : null) : undefined;

  if (values.json) {
    const salidaJson = {
      tarea: encontrada.tarea,
      estado: resumen?.estado ?? 'abierta',
      rol: encontrada.rol,
      fase: encontrada.primera?.fase ?? resumen?.fase ?? null,
      resuelta_en: resumen?.resuelta_en ?? null,
      escalada: Boolean(resumen?.escalada),
      descartada: Boolean(resumen?.descartada),
      duracion_ms: resumen?.duracion_ms ?? 0,
      tokens: resumen?.con_tokens ? resumen.tokens : null,
      worktree: wt
        ? { ruta: wt.ruta, rutaCorta: wt.rutaCorta, rama: wt.rama, integrada: wt.integrada, sinCommits: wt.sinCommits }
        : (encontrada.ultima?.worktree
          ? { ruta: path.resolve(raiz, encontrada.ultima.worktree), rama, existe: false, ramaExiste }
          : null),
      base,
      diff: comandoDiff,
      intento_consultado: intentoObjetivo.id,
      intentos: encontrada.intentos.map((d) => ({
        id: d.id,
        intento: d.intento ?? null,
        fecha: d.fecha,
        modelo: d.modelo,
        slug: d.slug ?? null,
        ejecutor: d.ejecutor ?? 'command_code',
        effort: d.effort ?? null,
        duracion_ms: d.duracion_ms ?? null,
        tokens: tokensTotales(d.uso),
        uso: d.uso ?? null,
        herramientas: d.herramientas ?? null,
        validacion: d.validacion ?? null,
        revision: revisiones.get(d.id) ?? null,
        exit_code: d.exit_code ?? null,
        codigo_ejecutor: d.codigo_ejecutor ?? null,
        interrumpida: d.interrumpida ?? null,
        archivos: d.archivos ?? [],
        archivos_acumulados: d.archivos_acumulados ?? [],
        avisos: d.avisos ?? [],
        alertas: d.alertas ?? [],
        criticas: d.criticas ?? [],
        prompt: d.prompt ?? null,
        salida: d.salida ?? null,
      })),
      ...(values.prompt ? { prompt_texto: promptTexto } : {}),
      ...(values.log ? { log_cola: logCola } : {}),
    };
    process.stdout.write(`${JSON.stringify(salidaJson, null, 2)}\n`);
    return SALIDA.OK;
  }

  const estado = resumen?.estado ?? 'abierta';
  const fase = encontrada.primera?.fase ?? resumen?.fase ?? null;
  const out = [
    `Tarea: ${encontrada.tarea} · estado: ${estado} · rol: ${encontrada.rol}${fase ? ` · fase: ${fase}` : ''}`,
  ];
  if (resumen) {
    const durSeg = (resumen.duracion_ms / 1000).toFixed(1);
    const tok = resumen.con_tokens ? String(resumen.tokens) : '—';
    out.push(`Totales: ${resumen.intentos} intento(s) · duración ${durSeg} s · tokens ${tok}`);
  }
  if (wt) {
    const estadoWt = wt.integrada ? 'integrada' : wt.sinCommits ? 'sin commits' : 'sin integrar';
    out.push(`Worktree: ${wt.rutaCorta} · rama: ${wt.rama} (${estadoWt})`);
  } else if (encontrada.ultima?.worktree || rama) {
    out.push(`Worktree: eliminado (${encontrada.ultima?.worktree ?? '—'})${rama ? ` · rama: ${rama}${ramaExiste ? '' : ' (eliminada)'}` : ''}`);
  } else {
    out.push('Worktree: — (rol de solo lectura)');
  }
  if (comandoDiff) out.push(`Diff: ${comandoDiff}`);

  out.push('', 'Intentos:');
  out.push(...tabla(
    ['Intento', 'ID', 'Modelo', 'Effort', 'Duración', 'Tokens', 'Validar', 'Revisión', 'Exit'],
    encontrada.intentos.map((d, idx) => {
      const marca = d.id === intentoObjetivo.id && encontrada.intentos.length > 1 ? '*' : '';
      const dur = d.duracion_ms != null ? `${(d.duracion_ms / 1000).toFixed(1)} s` : '—';
      const tok = tokensTotales(d.uso);
      const val = d.validacion ? (d.validacion.ok ? '✔' : '✘') : '—';
      const rev = revisiones.get(d.id)?.resultado ?? 'sin revisar';
      const exit = d.exit_code != null ? (d.interrumpida ? `${d.exit_code} (${d.interrumpida})` : String(d.exit_code)) : '—';
      return [
        `${d.intento ?? idx + 1}${marca}`,
        d.id,
        d.modelo ?? '—',
        d.effort ?? '—',
        dur,
        tok !== null ? String(tok) : '—',
        val,
        rev,
        exit,
      ];
    }),
  ));

  const notas = encontrada.intentos
    .map((d, idx) => ({ intento: d.intento ?? idx + 1, rev: revisiones.get(d.id) }))
    .filter((x) => x.rev?.nota);
  if (notas.length) {
    out.push('', 'Notas de revisión:');
    for (const n of notas) out.push(`  intento ${n.intento} (${n.rev.resultado}): ${n.rev.nota}`);
  }

  out.push('', `Rutas (intento ${intentoObjetivo.intento ?? encontrada.intentos.length} · ${intentoObjetivo.id}):`);
  out.push(`  prompt: ${intentoObjetivo.prompt ?? '—'}`);
  out.push(`  salida: ${intentoObjetivo.salida ?? '—'}`);
  if (intentoObjetivo.validacion?.log) out.push(`  validar.log: ${intentoObjetivo.validacion.log}`);

  if (intentoObjetivo.archivos?.length || intentoObjetivo.archivos_acumulados?.length) {
    const lista = intentoObjetivo.archivos_acumulados?.length ? intentoObjetivo.archivos_acumulados : intentoObjetivo.archivos;
    out.push(`  archivos (${lista.length}): ${lista.join(', ')}`);
  }

  const avisos = [];
  const alertas = [];
  const criticas = [];
  for (const d of encontrada.intentos) {
    const pref = encontrada.intentos.length > 1 ? `[intento ${d.intento ?? '?'}] ` : '';
    for (const a of d.avisos ?? []) avisos.push(`${pref}${a}`);
    for (const a of d.alertas ?? []) alertas.push(`${pref}${a}`);
    for (const c of d.criticas ?? []) criticas.push(`${pref}${c}`);
  }
  if (avisos.length) out.push('', 'Avisos:', ...avisos.map((a) => `  - ${a}`));
  if (alertas.length) out.push('', 'Alertas:', ...alertas.map((a) => `  - ${a}`));
  if (criticas.length) out.push('', '⚠ Críticas de integridad:', ...criticas.map((c) => `  - ${c}`));

  if (values.prompt) {
    out.push('', `--- prompt (${intentoObjetivo.id}) ---`);
    out.push(promptTexto !== null ? promptTexto.trimEnd() : `(no se encontró el archivo de prompt: ${intentoObjetivo.prompt ?? '—'})`);
  }
  if (values.log) {
    out.push('', `--- últimas 40 líneas de salida (${intentoObjetivo.id}) ---`);
    if (logCola === null) out.push(`(no se encontró el archivo de salida: ${intentoObjetivo.salida ?? '—'})`);
    else if (!logCola.length) out.push('(log de salida vacío)');
    else out.push(...logCola);
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return SALIDA.OK;
}
