// orq estado
// Configuración efectiva del repo actual: la skill le pide a Opus ejecutarlo antes de planificar.
// Es la fuente de verdad de los roles (con los ajustes del repo aplicados).

import path from 'node:path';
import { SALIDA, subagenteNativo, ejecutorDeFicha } from '../lib/registro.mjs';
import { ejecutorDe, ejecutoresEnUso } from '../lib/ejecutores/index.mjs';
import { registroEfectivo, rutasLogs, ARCHIVO_REPO } from '../lib/config.mjs';
import { raizRepo, leerJsonl, binDisponible } from '../lib/util.mjs';
import { worktreesDelegacion } from '../lib/worktrees.mjs';
import { configSandbox, sandboxDisponible } from '../lib/sandbox.mjs';
import { mapaRevisiones, resumirTareas } from '../lib/tareas.mjs';

function tabla(cab, filas) {
  const anchos = cab.map((c, i) => Math.max(c.length, ...filas.map((f) => f[i].length)));
  const linea = (cols) => `  ${cols.map((c, i) => c.padEnd(anchos[i])).join('  ')}`.trimEnd();
  return [linea(cab), ...filas.map(linea)];
}

function lineaSandbox(registro) {
  const { modo, lectura_denegada: denegadas, lectura_extra: lecturaExtra } = configSandbox(registro);
  if (modo === 'desactivado') return 'Sandbox: desactivado (los modelos delegados corren con todos tus permisos)';
  const d = sandboxDisponible();
  if (d.tipo) {
    const detalles = [
      denegadas.length ? `lectura denegada: ${denegadas.join(', ')}` : null,
      lecturaExtra.length ? `lectura extra: ${lecturaExtra.join(', ')}` : null,
    ].filter(Boolean);
    return `Sandbox: ${d.tipo} (modo ${modo})${detalles.length ? ` · ${detalles.join(' · ')}` : ''}`;
  }
  return modo === 'obligatorio'
    ? `Sandbox: NO DISPONIBLE (${d.motivo}); modo obligatorio, así que delegar está bloqueado`
    : `Sandbox: no disponible (${d.motivo}); los modelos delegados corren con todos tus permisos`;
}

export async function ejecutar() {
  const raiz = raizRepo();
  const { registro, ajustes, sensibilidad, repo } = registroEfectivo(raiz);
  const out = [];

  out.push(`Repo: ${path.basename(raiz)} (${raiz})`);
  if (repo.desactivado) {
    out.push(`Orquestador DESACTIVADO en este repo (${ARCHIVO_REPO}): trabaja sin delegar.`);
    process.stdout.write(`${out.join('\n')}\n`);
    return SALIDA.OK;
  }
  out.push(sensibilidad.sensible
    ? `Sensible: SÍ (${sensibilidad.motivos.join('; ')}). Los modelos delegados están bloqueados salvo los que tengan repos_sensibles: permitido; usa subagentes nativos.`
    : 'Sensible: no. Se puede delegar.');
  if (sensibilidad.intentoDesmarcar) out.push(`Aviso: ${ARCHIVO_REPO} dice sensible: false, pero el patrón global prevalece.`);
  const ajustados = Object.keys(ajustes?.datos?.roles ?? {});
  out.push(`Ajustes del repo: ${ajustes ? `${ARCHIVO_REPO}${ajustados.length ? ` (roles ajustados: ${ajustados.join(', ')})` : ''}` : 'ninguno (valores globales)'}`);
  const cc = registro.command_code ?? {};
  const bloqueados = new Set();
  for (const ej of ejecutoresEnUso(registro)) {
    if (!binDisponible(ej.bin(registro))) {
      bloqueados.add(ej.nombre);
      out.push(`${ej.etiqueta}: NO INSTALADO (${ej.bin(registro)} no está en el PATH): sus modelos no se pueden usar`);
      continue;
    }
    if (ej.nombre === 'command_code') {
      out.push(`Command Code: skills ${cc.skills_compatibles === true ? 'sí' : 'no (resume sus reglas en el prompt)'} · salida JSON ${cc.salida_json === true ? 'sí' : 'no'}`);
    } else {
      const acceso = ej.acceso(registro);
      if (acceso.bloqueo) bloqueados.add(ej.nombre);
      out.push(`${ej.etiqueta}: ${acceso.etiquetaModo}${acceso.bloqueo ? ' — BLOQUEADO (el registro no lo permite)' : ''} · skills no (resume sus reglas en el prompt)`);
    }
  }
  out.push(lineaSandbox(registro));
  out.push(`Preparar worktrees: ${repo.preparar.length ? repo.preparar.join(' && ') : '—'}`);
  out.push(`Validar tras delegar: ${repo.validar.length ? repo.validar.join(' && ') : '— (puedes declararlo en .claude/orquestador.yaml)'}`);

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
  for (const [id, f] of Object.entries(registro.models)) {
    const ej = ejecutorDe(ejecutorDeFicha(f));
    const extra = bloqueados.has(ej.nombre) ? ', bloqueado' : '';
    out.push(
      `  ${id} (${f.estado}, ${ej.etiqueta}${extra})${f.fortalezas ? ` · fortalezas: ${f.fortalezas}` : ''}` +
        `${f.debilidades ? ` · debilidades: ${f.debilidades}` : ''}`,
    );
  }
  if (registro.no_delegables?.length) out.push('', `Nunca se delegan: ${registro.no_delegables.join('; ')}.`);

  const wts = worktreesDelegacion(raiz);
  out.push('', `Worktrees de delegación: ${wts.length || 'ninguno'}`);
  const estadoWt = (w) => (w.integrada ? 'integrada (orq limpiar)' : w.sinCommits ? 'sin commits' : 'sin integrar');
  for (const w of wts) out.push(`  ${w.relativa}  ${w.rama}  ${estadoWt(w)}  · ${w.ultimo}`);

  const eventos = leerJsonl(rutasLogs().jsonl);
  // Una tarea de escritura cuyo worktree ya no existe no se puede continuar: no se lista.
  const ramas = new Set(wts.map((w) => w.rama));
  const abiertas = resumirTareas(eventos)
    .filter((t) => t.raiz === raiz && t.estado === 'abierta' && (!t.ultima?.worktree || ramas.has(`delegar/${t.tarea}`)))
    .slice(-10);
  if (abiertas.length) {
    out.push('', 'Tareas abiertas en este repo:');
    for (const t of abiertas) {
      const max = registro.roles[t.rol]?.max_intentos ?? '?';
      out.push(
        `  ${t.tarea}  ${t.rol}${t.fase ? ` · ${t.fase}` : ''} · intento ${t.intentos}/${max} · ${t.ultima_revision ?? 'sin revisar'}` +
          `  → orq delegar ${t.rol} --continuar ${t.tarea}`,
      );
    }
  }

  const revision = mapaRevisiones(eventos);
  const recientes = eventos.filter((e) => e.tipo === 'delegacion' && e.raiz === raiz).slice(-5);
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
