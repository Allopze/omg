// orq estado [--resumen] [--json]
// Configuración efectiva del repo actual: la skill le pide a Opus ejecutarlo antes de planificar.
// Es la fuente de verdad de los roles (con los ajustes del repo aplicados).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SALIDA, subagenteNativo, ejecutorDeFicha } from '../lib/registro.mjs';
import {
  ejecutorDe, ejecutoresEnUso, ejecutorRequerido, modelosDe, salidaJsonEfectiva,
} from '../lib/ejecutores/index.mjs';
import { registroEfectivo, rutasLogs, ARCHIVO_REPO } from '../lib/config.mjs';
import { raizRepo, leerJsonl, binDisponible } from '../lib/util.mjs';
import { worktreesDelegacion } from '../lib/worktrees.mjs';
import { configSandbox, sandboxDisponible, sandboxActivo } from '../lib/sandbox.mjs';
import { mapaRevisiones, resumirTareas, esAprobado } from '../lib/tareas.mjs';

export const AYUDA = [
  'Uso: orq estado [--resumen] [--json]',
  '',
  'Muestra la configuración efectiva del repo, ejecutores, sandbox, roles, worktrees y tareas abiertas.',
  '',
  'Opciones:',
  '  --resumen     Omite los bloques estáticos (roles, modelos por rol, whitelist y nunca se delegan)',
  '  --json        Imprime la salida en formato JSON estructurado',
  '  -h, --help    Muestra esta ayuda',
  '',
].join('\n');

function tabla(cab, filas) {
  const anchos = cab.map((c, i) => Math.max(c.length, ...filas.map((f) => f[i].length)));
  const linea = (cols) => `  ${cols.map((c, i) => c.padEnd(anchos[i])).join('  ')}`.trimEnd();
  return [linea(cab), ...filas.map(linea)];
}

function lineaSandbox(registro, disponible = sandboxDisponible()) {
  const { modo, lectura_denegada: denegadas, lectura_extra: lecturaExtra } = configSandbox(registro);
  if (modo === 'desactivado') return 'Sandbox: desactivado (los modelos delegados corren con todos tus permisos)';
  if (disponible.tipo) {
    const detalles = [
      denegadas.length ? `lectura denegada: ${denegadas.join(', ')}` : null,
      lecturaExtra.length ? `lectura extra: ${lecturaExtra.join(', ')}` : null,
    ].filter(Boolean);
    return `Sandbox: ${disponible.tipo} (modo ${modo})${detalles.length ? ` · ${detalles.join(' · ')}` : ''}`;
  }
  return modo === 'obligatorio'
    ? `Sandbox: NO DISPONIBLE (${disponible.motivo}); modo obligatorio, así que delegar está bloqueado`
    : `Sandbox: no disponible (${disponible.motivo}); los modelos delegados corren con todos tus permisos`;
}

function resumirTareaJson(t, registro) {
  return {
    tarea: t.tarea,
    rol: t.rol,
    fase: t.fase ?? null,
    intentos: t.intentos,
    max_intentos: registro.roles[t.rol]?.max_intentos ?? null,
    ultima_revision: t.ultima_revision ?? null,
    ultimo_intento_id: t.ultima?.id ?? null,
    worktree: t.ultima?.worktree ?? null,
  };
}

export async function ejecutar(argv = []) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      resumen: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(AYUDA);
    return SALIDA.OK;
  }

  const raiz = raizRepo();
  const { registro, ajustes, sensibilidad, repo } = registroEfectivo(raiz);

  const wts = worktreesDelegacion(raiz);
  const eventos = leerJsonl(rutasLogs().jsonl);
  const todasTareas = resumirTareas(eventos).filter((t) => t.raiz === raiz);
  const tareaPorId = new Map(todasTareas.map((t) => [t.tarea, t]));
  const ramas = new Set(wts.map((w) => w.rama));
  // Una tarea de escritura cuyo worktree ya no existe no se puede continuar: no se lista.
  const abiertasEscrituraAll = todasTareas.filter(
    (t) => t.estado === 'abierta' && Boolean(t.ultima?.worktree) && ramas.has(`delegar/${t.tarea}`),
  );
  const abiertasLecturaAll = todasTareas.filter((t) => t.estado === 'abierta' && !t.ultima?.worktree);
  const revision = mapaRevisiones(eventos);
  const recientes = eventos.filter((e) => e?.tipo === 'delegacion' && e.raiz === raiz).slice(-5);

  const cc = registro.command_code ?? {};
  const bloqueados = new Set();
  const opcionalesNoInstalados = new Set();
  const avisosEstado = [];
  const infoEjecutores = [];
  const sbConfig = configSandbox(registro);
  const sbDisp = sandboxDisponible();
  const sbActivo = sandboxActivo(registro, sbDisp);

  if (!repo.desactivado) {
    for (const ej of ejecutoresEnUso(registro)) {
      const bin = ej.bin(registro);
      const instalado = binDisponible(bin);
      const requerido = ejecutorRequerido(registro, ej);
      if (!instalado) {
        bloqueados.add(ej.nombre);
        if (!requerido) {
          opcionalesNoInstalados.add(ej.nombre);
          const n = modelosDe(registro, ej).length;
          infoEjecutores.push({
            nombre: ej.nombre, etiqueta: ej.etiqueta, bin, instalado: false, requerido: false,
            opcional: true, modelos_omitidos: n, bloqueado: true,
          });
        } else {
          infoEjecutores.push({
            nombre: ej.nombre, etiqueta: ej.etiqueta, bin, instalado: false, requerido: true,
            opcional: false, bloqueado: true,
          });
        }
        continue;
      }
      if (ej.nombre === 'command_code') {
        const jsonInfo = salidaJsonEfectiva(registro, ej, bin);
        infoEjecutores.push({
          nombre: ej.nombre, etiqueta: ej.etiqueta, bin, instalado: true, requerido, bloqueado: false,
          skills_compatibles: cc.skills_compatibles ?? null,
          salida_json: cc.salida_json ?? null,
          salida_json_efectiva: jsonInfo,
        });
      } else {
        const acceso = ej.acceso(registro);
        if (acceso.bloqueo) bloqueados.add(ej.nombre);
        if (acceso.avisoSettings) avisosEstado.push(acceso.avisoSettings);
        if (ej.nombre === 'antigravity' && !sbActivo) {
          avisosEstado.push(
            `${ej.etiqueta} sin sandbox en roles de solo lectura (--mode plan) puede auto-denegar comandos de shell y devolver respuesta vacía.`,
          );
        }
        infoEjecutores.push({
          nombre: ej.nombre, etiqueta: ej.etiqueta, bin, instalado: true, requerido,
          bloqueado: Boolean(acceso.bloqueo), acceso,
        });
      }
    }
  }

  const ajustados = Object.keys(ajustes?.datos?.roles ?? {});

  if (values.json) {
    const datos = {
      repo: {
        nombre: path.basename(raiz),
        raiz,
        desactivado: repo.desactivado,
        sensible: repo.desactivado ? null : sensibilidad.sensible,
        motivos_sensible: repo.desactivado ? [] : sensibilidad.motivos,
        intento_desmarcar: repo.desactivado ? false : sensibilidad.intentoDesmarcar,
        ajustes: ajustes ? ARCHIVO_REPO : null,
        roles_ajustados: repo.desactivado ? [] : ajustados,
        preparar: repo.preparar,
        validar: repo.validar,
      },
      ejecutores: repo.desactivado ? [] : infoEjecutores,
      sandbox: repo.desactivado ? null : {
        modo: sbConfig.modo,
        disponible: Boolean(sbDisp.tipo),
        tipo: sbDisp.tipo ?? null,
        motivo: sbDisp.motivo ?? null,
        activo: sbActivo,
        lectura_denegada: sbConfig.lectura_denegada,
        lectura_extra: sbConfig.lectura_extra,
      },
      avisos: repo.desactivado ? [] : avisosEstado,
      ...(!repo.desactivado && !values.resumen ? {
        roles: Object.fromEntries(
          Object.entries(registro.roles).map(([n, r]) => [
            n,
            {
              descripcion: r.descripcion ?? null,
              primario: r.primario,
              permitidos: r.permitidos,
              effort: r.effort,
              effort_reintento: r.effort_reintento,
              max_intentos: r.max_intentos,
              yolo: r.yolo,
              max_archivos: r.max_archivos ?? null,
              rutas_permitidas: r.rutas_permitidas ?? null,
              skills: r.skills ?? [],
              escala_a: r.escala_a,
            },
          ]),
        ),
        models: Object.fromEntries(
          Object.entries(registro.models).map(([id, f]) => {
            const ej = ejecutorDe(ejecutorDeFicha(f));
            return [id, { ...f, ejecutor: ej.nombre, bloqueado: bloqueados.has(ej.nombre) }];
          }),
        ),
        no_delegables: registro.no_delegables ?? [],
      } : {}),
      worktrees: wts.map((w) => {
        const t = tareaPorId.get(w.id);
        return {
          id: w.id,
          rama: w.rama,
          ruta: w.ruta,
          relativa: w.relativa,
          ruta_corta: w.rutaCorta,
          integrada: w.integrada,
          sin_commits: w.sinCommits,
          ultimo: w.ultimo,
          fase: t?.fase ?? null,
          ultima_revision: t?.ultima_revision ?? null,
          listo_para_merge: !w.integrada && !w.sinCommits && esAprobado(t?.ultima_revision),
        };
      }),
      tareas_abiertas: abiertasEscrituraAll.map((t) => resumirTareaJson(t, registro)),
      tareas_abiertas_lectura: abiertasLecturaAll.map((t) => resumirTareaJson(t, registro)),
      ultimas_delegaciones: recientes.map((d) => ({
        id: d.id,
        tarea: d.tarea ?? d.id,
        rol: d.rol,
        modelo: d.modelo,
        intento: d.intento,
        revision: revision.get(d.id) ?? null,
        validacion_ok: d.validacion ? d.validacion.ok : null,
        alertas: d.alertas ?? [],
        criticas: d.criticas ?? [],
      })),
    };
    process.stdout.write(`${JSON.stringify(datos, null, 2)}\n`);
    return SALIDA.OK;
  }

  const out = [];
  out.push(`Repo: ${path.basename(raiz)} (${raiz})`);
  if (repo.desactivado) {
    out.push(`Orquestador DESACTIVADO en este repo (${ARCHIVO_REPO}): trabaja sin delegar.`);
  } else {
    out.push(sensibilidad.sensible
      ? `Sensible: SÍ (${sensibilidad.motivos.join('; ')}). Los modelos delegados están bloqueados salvo los que tengan repos_sensibles: permitido; usa subagentes nativos.`
      : 'Sensible: no. Se puede delegar.');
    if (sensibilidad.intentoDesmarcar) out.push(`Aviso: ${ARCHIVO_REPO} dice sensible: false, pero el patrón global prevalece.`);
    out.push(`Ajustes del repo: ${ajustes ? `${ARCHIVO_REPO}${ajustados.length ? ` (roles ajustados: ${ajustados.join(', ')})` : ''}` : 'ninguno (valores globales)'}`);

    for (const info of infoEjecutores) {
      if (!info.instalado) {
        if (info.opcional) {
          out.push(`${info.etiqueta} (opcional): no instalado — ${info.modelos_omitidos} modelo(s) omitidos`);
        } else {
          out.push(`${info.etiqueta}: NO INSTALADO (${info.bin} no está en el PATH): sus modelos no se pueden usar`);
        }
        continue;
      }
      if (info.nombre === 'command_code') {
        const skillsTxt = info.skills_compatibles === true
          ? 'sí'
          : info.skills_compatibles === false
            ? 'no (resume sus reglas en el prompt)'
            : 'sin verificar';
        const jsonTxt = info.salida_json_efectiva.activo
          ? (info.salida_json_efectiva.automatico ? 'sí (auto >= 1.0)' : 'sí')
          : (info.salida_json === false ? 'no' : 'sin verificar (orq verificar --capacidades --guardar)');
        out.push(`Command Code: skills ${skillsTxt} · salida JSON ${jsonTxt}`);
      } else {
        const a = info.acceso;
        out.push(`${info.etiqueta}: ${a.etiquetaModo}${a.bloqueo ? ' — BLOQUEADO (el registro no lo permite)' : ''} · skills no (resume sus reglas en el prompt)`);
      }
    }
    for (const av of avisosEstado) out.push(`Aviso: ${av}`);
    out.push(lineaSandbox(registro, sbDisp));
    out.push(`Preparar worktrees: ${repo.preparar.length ? repo.preparar.join(' && ') : '—'}`);
    out.push(`Validar tras delegar: ${repo.validar.length ? repo.validar.join(' && ') : '— (puedes declararlo en .claude/orquestador.yaml)'}`);

    if (!values.resumen) {
      out.push('', 'Roles (valores efectivos en este repo):');
      out.push(...tabla(
        ['Rol', 'Effort', 'Escribe', 'Rutas', 'Skills', 'Si se agotan los intentos'],
        Object.entries(registro.roles).map(([n, r]) => [
          n, `${r.effort} → ${r.effort_reintento}`, r.yolo ? `sí${r.max_archivos ? `, máx. ${r.max_archivos}` : ''}` : 'no',
          r.rutas_permitidas?.join(', ') ?? '—', r.skills?.length ? r.skills.join(', ') : '—',
          r.escala_a.map((d) => (d.startsWith('nativo:') ? subagenteNativo(d, r.yolo) : d)).join(', '),
        ]),
      ));

      out.push('', 'Cuándo usar cada rol:');
      const ancho = Math.max(...Object.keys(registro.roles).map((n) => n.length));
      for (const [n, r] of Object.entries(registro.roles)) out.push(`  ${n.padEnd(ancho)}  ${r.descripcion ?? '—'}`);

      out.push('', 'Modelos por rol (el primero es el primario; otro de la lista con --modelo <id>):');
      for (const [n, r] of Object.entries(registro.roles)) {
        const otros = r.permitidos.filter((m) => m !== r.primario);
        out.push(`  ${n.padEnd(ancho)}  ${[r.primario, ...otros].join(', ')}`);
      }

      out.push('', 'Whitelist de modelos delegables:');
      const omitidosPorEj = new Map();
      for (const [id, f] of Object.entries(registro.models)) {
        const ej = ejecutorDe(ejecutorDeFicha(f));
        if (opcionalesNoInstalados.has(ej.nombre)) {
          if (!omitidosPorEj.has(ej.nombre)) omitidosPorEj.set(ej.nombre, { etiqueta: ej.etiqueta, ids: [] });
          omitidosPorEj.get(ej.nombre).ids.push(id);
          continue;
        }
        const extra = bloqueados.has(ej.nombre) ? ', bloqueado' : '';
        out.push(
          `  ${id} (${f.estado}, ${ej.etiqueta}${extra})${f.fortalezas ? ` · fortalezas: ${f.fortalezas}` : ''}` +
            `${f.debilidades ? ` · debilidades: ${f.debilidades}` : ''}`,
        );
      }
      for (const { etiqueta, ids } of omitidosPorEj.values()) {
        out.push(`  (${etiqueta} opcional no instalado: ${ids.length} modelo(s) omitidos — ${ids.join(', ')})`);
      }
      if (registro.no_delegables?.length) out.push('', `Nunca se delegan: ${registro.no_delegables.join('; ')}.`);
    }
  }

  out.push('', `Worktrees de delegación: ${wts.length || 'ninguno'}`);
  const estadoWt = (w) => (w.integrada ? 'integrada (orq limpiar)' : w.sinCommits ? 'sin commits' : 'sin integrar');
  for (const w of wts) {
    const t = tareaPorId.get(w.id);
    const rev = t?.ultima_revision ?? 'sin revisar';
    const faltaDir = !fs.existsSync(w.ruta) ? 'carpeta eliminada' : null;
    const detalles = [estadoWt(w), faltaDir, t?.fase ?? null, rev, w.ultimo || null].filter(Boolean);
    const mergeHint = !w.integrada && !w.sinCommits && esAprobado(t?.ultima_revision)
      ? `  → git merge --no-ff ${w.rama}`
      : '';
    out.push(`  ${w.rutaCorta}  ${w.rama}  ${detalles.join(' · ')}${mergeHint}`);
  }

  const abiertasEscritura = abiertasEscrituraAll.slice(-10);
  if (abiertasEscritura.length) {
    out.push('', 'Tareas abiertas en este repo:');
    for (const t of abiertasEscritura) {
      const max = registro.roles[t.rol]?.max_intentos ?? '?';
      out.push(
        `  ${t.tarea}  ${t.rol}${t.fase ? ` · ${t.fase}` : ''} · intento ${t.intentos}/${max} · ${t.ultima_revision ?? 'sin revisar'}` +
          `  → orq delegar ${t.rol} --continuar ${t.tarea}`,
      );
    }
  }

  const abiertasLectura = abiertasLecturaAll.slice(-10);
  if (abiertasLectura.length) {
    out.push('', 'Tareas abiertas de solo lectura:');
    for (const t of abiertasLectura) {
      const max = registro.roles[t.rol]?.max_intentos ?? '?';
      const accion = t.ultima_revision === 'corregido'
        ? `orq delegar ${t.rol} --continuar ${t.tarea} | orq limpiar --descartar ${t.tarea}`
        : `orq revision ${t.ultima?.id ?? t.tarea} aprobado|corregido | orq limpiar --descartar ${t.tarea}`;
      out.push(
        `  ${t.tarea}  ${t.rol}${t.fase ? ` · ${t.fase}` : ''} · intento ${t.intentos}/${max} · ${t.ultima_revision ?? 'sin revisar'}` +
          `  → ${accion}`,
      );
    }
  }

  if (recientes.length) {
    out.push('', 'Últimas delegaciones en este repo:');
    for (const d of recientes) {
      const extras = [
        d.validacion ? `validar ${d.validacion.ok ? '✔' : '✘'}` : null,
        d.alertas?.length ? `${d.alertas.length} alerta(s)` : null,
        d.criticas?.length ? `${d.criticas.length} crítica(s)` : null,
      ].filter(Boolean);
      out.push(`  ${d.id}  ${d.rol} · intento ${d.intento} · ${revision.get(d.id) ?? 'sin revisar'}${extras.length ? ` · ${extras.join(' · ')}` : ''}`);
    }
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return SALIDA.OK;
}
