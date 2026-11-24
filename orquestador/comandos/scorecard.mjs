// orq scorecard [--desde AAAA-MM-DD] [--repo NOMBRE | --aqui] [--json]
// Agrega los logs de todos los repos y sugiere cambios a la whitelist según los umbrales del registro.
// Mide por delegación (aprobación, validación, tokens) y por tarea (intentos hasta resolver, escalamientos).
// Las sugerencias son propuestas: los cambios a models.yaml los aprueba el usuario.

import { parseArgs } from 'node:util';
import { cargarRegistro, tokensTotales, ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { RUTA_REGISTRO, rutasLogs } from '../lib/config.mjs';
import { raizRepo, leerJsonl } from '../lib/util.mjs';
import { mapaRevisiones, resumirTareas, esAprobado } from '../lib/tareas.mjs';

const tokensDe = (d) => tokensTotales(d.uso);

/** "AAAA-MM-DD" como medianoche local en ISO (las fechas del log están en UTC). */
export function desdeComoIso(desde) {
  if (!desde) return null;
  return desde.includes('T') ? desde : new Date(`${desde}T00:00:00`).toISOString();
}

export function calcularScorecard(eventos, registro, { desde, repo, raiz } = {}) {
  const desdeIso = desdeComoIso(desde);
  const enRepo = (e) => (!repo || e.repo === repo) && (!raiz || e.raiz === raiz);
  const enRango = (e) => enRepo(e) && (!desdeIso || e.fecha >= desdeIso);
  const delegaciones = eventos.filter((e) => e.tipo === 'delegacion' && enRango(e));
  const escalamientos = eventos.filter((e) => e.tipo === 'escalamiento' && enRango(e));
  const revision = mapaRevisiones(eventos);

  const grupos = new Map();
  for (const d of delegaciones) {
    const skills = d.skills?.length ? d.skills.join('+') : '—';
    const clave = [d.modelo, d.rol, d.effort, skills].join('|');
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        modelo: d.modelo, ejecutor: d.ejecutor ?? 'command_code', rol: d.rol, effort: d.effort, skills, repos: new Set(),
        delegaciones: 0, revisadas: 0, aprobadas: 0, ajustadas: 0, primer_intento_revisadas: 0, primer_intento_aprobadas: 0,
        con_alertas: 0, con_criticas: 0, validadas: 0, validadas_ok: 0, duracion_total_ms: 0,
        con_uso: 0, tokens_entrada: 0, tokens_salida: 0, tokens_razonamiento: 0, tokens_total: 0, costo: 0,
      });
    }
    const g = grupos.get(clave);
    g.delegaciones++;
    g.repos.add(d.raiz ?? d.repo);
    g.duracion_total_ms += d.duracion_ms ?? 0;
    if (d.alertas?.length) g.con_alertas++;
    if (d.criticas?.length) g.con_criticas++;
    if (d.validacion) {
      g.validadas++;
      if (d.validacion.ok) g.validadas_ok++;
    }
    if (d.uso) {
      g.con_uso++;
      g.tokens_entrada += d.uso.entrada ?? 0;
      g.tokens_salida += d.uso.salida ?? 0;
      g.tokens_razonamiento += d.uso.razonamiento ?? 0;
      g.tokens_total += tokensTotales(d.uso) ?? 0;
      g.costo += d.uso.costo ?? 0;
    }
    const r = revision.get(d.id);
    if (r) {
      g.revisadas++;
      if (esAprobado(r)) g.aprobadas++;
      if (r === 'ajustado') g.ajustadas++;
      if (d.intento === 1) {
        g.primer_intento_revisadas++;
        if (esAprobado(r)) g.primer_intento_aprobadas++;
      }
    }
  }
  const filas = [...grupos.values()].map(({ repos, ...g }) => ({
    ...g,
    repos: repos.size,
    tasa_aprobacion: g.revisadas ? g.aprobadas / g.revisadas : null,
    tasa_primer_intento: g.primer_intento_revisadas ? g.primer_intento_aprobadas / g.primer_intento_revisadas : null,
    tasa_validacion: g.validadas ? g.validadas_ok / g.validadas : null,
    duracion_media_min: g.delegaciones ? g.duracion_total_ms / g.delegaciones / 60000 : null,
    tokens_medios: g.con_uso ? g.tokens_total / g.con_uso : null,
  }));

  // Por tarea: cuántos intentos hicieron falta y cuántas terminaron escaladas. Se agrupan con todos sus
  // intentos (aunque alguno sea anterior a --desde) y se cuentan las tareas que empezaron en el rango.
  const tareas = resumirTareas(eventos.filter((e) => ['revision', 'descarte'].includes(e.tipo) || enRepo(e)))
    .filter((t) => enRepo(t) && (!desdeIso || t.inicio >= desdeIso));
  const porRol = new Map();
  for (const t of tareas) {
    if (!porRol.has(t.rol)) {
      porRol.set(t.rol, {
        rol: t.rol, tareas: 0, resueltas_primer_intento: 0, resueltas_con_reintento: 0, escaladas: 0, descartadas: 0, abiertas: 0,
        intentos: 0, duracion_ms: 0, tokens: 0, con_tokens: 0,
      });
    }
    const g = porRol.get(t.rol);
    g.tareas++;
    g.intentos += t.intentos;
    g.duracion_ms += t.duracion_ms;
    if (t.estado === 'resuelta') {
      if (t.resuelta_en === 1) g.resueltas_primer_intento++;
      else g.resueltas_con_reintento++;
    } else if (t.estado === 'escalada') g.escaladas++;
    else if (t.estado === 'descartada') g.descartadas++;
    else g.abiertas++;
    if (t.con_tokens) {
      g.tokens += t.tokens;
      g.con_tokens++;
    }
  }
  const tareasPorRol = [...porRol.values()].map(({ duracion_ms, tokens, con_tokens, ...g }) => ({
    ...g,
    intentos_por_tarea: g.intentos / g.tareas,
    min_por_tarea: duracion_ms / g.tareas / 60000,
    tokens_por_tarea: con_tokens ? tokens / con_tokens : null,
  }));

  const totales = {
    delegaciones: delegaciones.length,
    tareas: tareas.length,
    minutos_command_code: delegaciones.reduce((s, d) => s + (d.duracion_ms ?? 0), 0) / 60000,
    tokens: delegaciones.some((d) => d.uso) ? delegaciones.reduce((s, d) => s + (tokensDe(d) ?? 0), 0) : null,
    costo: delegaciones.some((d) => d.uso?.costo !== null && d.uso?.costo !== undefined)
      ? delegaciones.reduce((s, d) => s + (d.uso?.costo ?? 0), 0) : null,
    ajustadas: delegaciones.filter((d) => revision.get(d.id) === 'ajustado').length,
  };

  const u = registro.umbrales ?? {};
  const sugerencias = [];
  for (const [id, ficha] of Object.entries(registro.models)) {
    const revisadas = delegaciones
      .filter((d) => d.modelo === id && revision.has(d.id))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
    const tasa = (lista) => lista.filter((d) => esAprobado(revision.get(d.id))).length / lista.length;
    if (ficha.estado === 'en_prueba' && u.promocion && revisadas.length >= u.promocion.min_tareas) {
      const t = tasa(revisadas);
      if (t >= u.promocion.tasa_aprobacion) {
        sugerencias.push(`Promover ${id} a activo: ${(t * 100).toFixed(0)} % aprobado en ${revisadas.length} delegaciones revisadas.`);
      }
    }
    if (ficha.estado === 'activo' && u.degradacion && revisadas.length >= u.degradacion.ultimas_tareas) {
      const ultimas = revisadas.slice(-u.degradacion.ultimas_tareas);
      const t = tasa(ultimas);
      if (t < u.degradacion.tasa_aprobacion) {
        sugerencias.push(`Pasar ${id} a en_prueba: ${(t * 100).toFixed(0)} % aprobado en las últimas ${ultimas.length} delegaciones revisadas.`);
      }
    }
  }
  const minMuestra = u.promocion?.min_tareas ?? 5;
  for (const g of tareasPorRol) {
    if (u.segundo_modelo && g.tareas >= minMuestra && g.escaladas / g.tareas > u.segundo_modelo.tasa_escalamiento) {
      sugerencias.push(
        `Rol "${g.rol}" escala a nativo en ${((g.escaladas / g.tareas) * 100).toFixed(0)} % de ${g.tareas} tareas: evalúa sumar un segundo modelo.`,
      );
    }
  }
  return { filas, tareas: tareasPorRol, totales, escalamientos: escalamientos.length, sugerencias };
}

const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(0)} %`);
const num = (v, dec = 1) => (v === null || v === undefined ? '—' : v.toFixed(dec));
const miles = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('es-CL'));

function tabla(cab, datos) {
  const anchos = cab.map((c, i) => Math.max(c.length, ...datos.map((d) => d[i].length)));
  const linea = (cols) => cols.map((c, i) => c.padEnd(anchos[i])).join('  ').trimEnd();
  return [linea(cab), anchos.map((a) => '-'.repeat(a)).join('  '), ...datos.map(linea)].join('\n');
}

function imprimir({ filas, tareas, totales, escalamientos, sugerencias }, filtro) {
  if (!filas.length) {
    process.stdout.write(`Todavía no hay delegaciones registradas${filtro ? ` para ${filtro}` : ''}.\n`);
    return;
  }
  if (filtro) process.stdout.write(`Filtro: ${filtro}\n\n`);
  process.stdout.write(`Por delegación\n${tabla(
    ['Modelo', 'Rol', 'Effort', 'Skills', 'Repos', 'Deleg.', 'Revis.', 'Aprob.', '1er intento', 'Ajust.', 'Validar', 'Alertas', 'Críticas', 'Min. prom.', 'Tokens prom.'],
    filas.map((f) => [
      f.modelo, f.rol, f.effort, f.skills, String(f.repos), String(f.delegaciones), String(f.revisadas),
      pct(f.tasa_aprobacion), pct(f.tasa_primer_intento), String(f.ajustadas), pct(f.tasa_validacion),
      String(f.con_alertas), String(f.con_criticas), num(f.duracion_media_min), miles(f.tokens_medios),
    ]),
  )}\n`);
  process.stdout.write(`\nPor tarea (intentos de una misma subtarea)\n${tabla(
    ['Rol', 'Tareas', 'Al 1er intento', 'Con reintento', 'Escaladas', 'Descartadas', 'Abiertas', 'Intentos/tarea', 'Min./tarea', 'Tokens/tarea'],
    tareas.map((t) => [
      t.rol, String(t.tareas), String(t.resueltas_primer_intento), String(t.resueltas_con_reintento), String(t.escaladas),
      String(t.descartadas), String(t.abiertas), num(t.intentos_por_tarea), num(t.min_por_tarea), miles(t.tokens_por_tarea),
    ]),
  )}\n`);
  process.stdout.write(
    `\nTotales: ${totales.delegaciones} delegaciones en ${totales.tareas} tareas · ${num(totales.minutos_command_code)} min de Command Code` +
      ` · tokens ${miles(totales.tokens)}${totales.costo !== null ? ` · costo ${totales.costo.toFixed(4)}` : ''}` +
      ` · ${totales.ajustadas} ajuste(s) manual(es) de Opus\n`,
  );
  if (totales.tokens === null) {
    process.stdout.write('  (sin datos de tokens: activa la salida JSON con orq verificar --guardar)\n');
  }
  process.stdout.write(`Escalamientos a modelos nativos: ${escalamientos}\n`);
  process.stdout.write(sugerencias.length
    ? `\nSugerencias (requieren tu aprobación):\n- ${sugerencias.join('\n- ')}\n`
    : '\nSin sugerencias de cambio.\n');
}

export async function ejecutar(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      desde: { type: 'string' }, repo: { type: 'string' },
      aqui: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    },
  });
  if (values.desde && !/^\d{4}-\d{2}-\d{2}$/.test(values.desde)) throw new ErrorOrquestador('--desde debe tener formato AAAA-MM-DD.');
  if (values.aqui && values.repo) throw new ErrorOrquestador('Usa --aqui o --repo, no ambos.');
  const raiz = values.aqui ? raizRepo() : undefined;
  const resultado = calcularScorecard(leerJsonl(rutasLogs().jsonl), cargarRegistro(RUTA_REGISTRO), {
    desde: values.desde, repo: values.repo, raiz,
  });
  if (values.json) process.stdout.write(`${JSON.stringify(resultado, null, 2)}\n`);
  else imprimir(resultado, [raiz && `repo ${raiz}`, values.repo && `repo ${values.repo}`, values.desde && `desde ${values.desde}`].filter(Boolean).join(', '));
  return SALIDA.OK;
}
