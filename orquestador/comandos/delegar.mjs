// orq delegar <rol> [opciones] <<'PROMPT' ... PROMPT
//
//   --continuar ID        Reintenta una tarea (id de tarea o de una de sus delegaciones). orq calcula el
//                         intento, reutiliza el worktree de la tarea y escala cuando se agotan los intentos.
//   --worktree RUTA       Igual que --continuar, identificando la tarea por la ruta de su worktree.
//   --fase TEXTO          Etiqueta libre para el log (ej. "Fase 2").
//   --modelo ID           Otro modelo dentro de `permitidos` del rol.
//   --prompt-archivo RUTA Lee el prompt desde un archivo en vez de stdin.
//   --dry-run             Muestra lo que haría sin ejecutar nada (ni registrar escalamientos).
//
// Códigos de salida: 0 terminó · 1 el modelo delegado (o orq) falló · 2 uso o configuración · 3 bloqueado ·
// 4 escalar · 5 integridad · 124 timeout. El código propio del ejecutor queda en el log y en el resumen.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  resolverDelegacion, construirPrompt, subagenteNativo, archivosFueraDeRutas, archivosDeConfiguracion,
  ErrorOrquestador, SALIDA,
} from '../lib/registro.mjs';
import { registroEfectivo, rutasLogs, expandirHome, dirWorktrees, ARCHIVO_REPO } from '../lib/config.mjs';
import { ejecutorDe } from '../lib/ejecutores/index.mjs';
import {
  git, raizRepo, nuevoId, agregarLinea, leerJsonl, leerStdin, rutasConCambios, ultimasLineas, archivosDelDiff, binDisponible,
} from '../lib/util.mjs';
import { buscarTarea, resumirTareas } from '../lib/tareas.mjs';
import { ejecutarProceso } from '../lib/proceso.mjs';
import { envolverEnSandbox, sandboxActivo, entornoSinSecretos, entornoSandbox, SECRETOS_EXTRA } from '../lib/sandbox.mjs';
import { huellaArchivos, releerHuellaArchivos, huellaGit, compararArchivos, compararGit } from '../lib/integridad.mjs';
import {
  guardarMeta, worktreeDeTarea, crearWorktree, tmpPrivado, correrComandos, descartarCambios, reposAnidados, gitlinksNuevos,
} from '../lib/worktree-tarea.mjs';

const resumirLista = (xs, n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} y ${xs.length - n} más` : xs.join(', '));

function leerOpciones(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      continuar: { type: 'string' },
      worktree: { type: 'string' },
      fase: { type: 'string' },
      modelo: { type: 'string' },
      'prompt-archivo': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      intento: { type: 'string' },
    },
  });
  if (values.intento !== undefined) {
    throw new ErrorOrquestador('--intento ya no existe: orq calcula el intento. Para reintentar usa --continuar <id de la tarea>.');
  }
  if (values.continuar && values.worktree) throw new ErrorOrquestador('Usa --continuar o --worktree, no ambos.');
  if (positionals.length !== 1) {
    throw new ErrorOrquestador('Uso: orq delegar <rol> [--continuar ID] [--fase TEXTO] <<\'PROMPT\' ... PROMPT');
  }
  return { rol: positionals[0], ...values, continuar: values.continuar ?? values.worktree };
}

function commitear(wt, res, id, excluirTambien = []) {
  const excluir = [...wt.excluir, ...excluirTambien.map((r) => r.replace(/\/$/, ''))];
  git(['add', '-A', '--', '.', ...excluir.map((p) => `:(exclude,literal)${p}`)], wt.ruta);
  if (git(['diff', '--cached', '--name-only', '-z'], wt.ruta, { crudo: true }).length) {
    git([
      '-c', `user.name=orquestador (${res.modelo})`, '-c', 'user.email=orquestador@local',
      'commit', '--no-verify', '-q', '-m', `delegar(${res.rol}): intento ${res.intento} [${id}]`,
    ], wt.ruta);
  }
}

function mensajeEscalar({ res, previa, wtPrevio }) {
  const destinos = res.escala_a.map((d) => `${d} → subagente "${subagenteNativo(d, res.yolo)}"`);
  return `Se agotaron los ${res.max_intentos} intentos de "${res.rol}" con los modelos delegados para la tarea ${previa.tarea}.\n` +
    `Escala a: ${destinos.join(', ')}.\n` +
    (wtPrevio ? `Pasa al subagente el worktree ${wtPrevio.ruta} (rama ${wtPrevio.rama}) para que continúe ahí.\n` : '');
}

export async function ejecutar(argv) {
  const opciones = leerOpciones(argv);
  const raiz = raizRepo();
  const logs = rutasLogs();
  const { registro, sensibilidad, repo: ajustesRepo } = registroEfectivo(raiz);

  if (ajustesRepo.desactivado) {
    throw new ErrorOrquestador(
      `El orquestador está desactivado en este repo (${ARCHIVO_REPO} dice desactivado: true). Haz la tarea sin delegar.`,
      SALIDA.BLOQUEADO,
    );
  }
  if (sensibilidad.intentoDesmarcar) {
    process.stderr.write('Aviso: .claude/orquestador.yaml dice sensible: false, pero el repo coincide con repos_sensibles global; se trata como sensible.\n');
  }

  // Tarea: nueva, o continuación de una anterior (el intento lo calcula orq a partir del log).
  const eventos = leerJsonl(logs.jsonl);
  let previa = null;
  if (opciones.continuar) {
    previa = buscarTarea(eventos, raiz, opciones.continuar);
    if (!previa) throw new ErrorOrquestador(`No hay una tarea "${opciones.continuar}" en este repo. orq estado lista las tareas abiertas.`);
    if (previa.rol !== opciones.rol) {
      throw new ErrorOrquestador(`La tarea ${previa.tarea} es del rol "${previa.rol}". Usa: orq delegar ${previa.rol} --continuar ${previa.tarea}`);
    }
  }
  const intento = previa ? previa.intentos.length + 1 : 1;
  const fase = opciones.fase ?? previa?.primera.fase ?? null;

  let res;
  try {
    res = resolverDelegacion(registro, { rol: opciones.rol, intento, modelo: opciones.modelo });
  } catch (e) {
    if (e.codigo === SALIDA.BLOQUEADO && sensibilidad.sensible) e.message += `\nMotivo: ${sensibilidad.motivos.join('; ')}.`;
    throw e;
  }

  const rolEscribe = registro.roles[opciones.rol].yolo;
  if (res.accion === 'escalar') {
    let wtPrevio = null;
    try {
      if (rolEscribe) wtPrevio = worktreeDeTarea(raiz, logs, previa);
    } catch { /* sin worktree: el subagente empieza desde el checkout */ }
    // Con --dry-run se informa, pero no se registra: la tarea no queda marcada como escalada.
    if (!opciones['dry-run']) {
      agregarLinea(logs.jsonl, {
        tipo: 'escalamiento', id: nuevoId(res.rol), tarea: previa.tarea, fecha: new Date().toISOString(),
        repo: path.basename(raiz), raiz, rol: res.rol, intento_solicitado: res.intento, escala_a: res.escala_a, fase,
      });
    }
    process.stdout.write(mensajeEscalar({ res, previa, wtPrevio }));
    return SALIDA.ESCALAR;
  }
  const wtPrevio = previa && rolEscribe ? worktreeDeTarea(raiz, logs, previa) : null;

  const ej = ejecutorDe(res.ejecutor);
  const acceso = ej.acceso(registro);
  if (acceso.bloqueo) throw new ErrorOrquestador(acceso.bloqueo, SALIDA.BLOQUEADO);

  const avisos = [];
  if (!previa && fase) {
    const abiertas = resumirTareas(eventos).filter((t) => t.raiz === raiz && t.rol === res.rol && t.fase === fase && t.estado === 'abierta');
    if (abiertas.length) {
      avisos.push(
        `Ya había ${abiertas.length} tarea(s) abierta(s) de "${res.rol}" para "${fase}" (${abiertas.map((t) => t.tarea).join(', ')}). ` +
          `Si esto era un reintento, usa --continuar ${abiertas.at(-1).tarea} para que cuente el intento.`,
      );
    }
  }

  const promptUsuario = opciones['prompt-archivo']
    ? fs.readFileSync(path.resolve(opciones['prompt-archivo']), 'utf8')
    : leerStdin();
  if (!promptUsuario.trim()) throw new ErrorOrquestador('El prompt está vacío. Pásalo por stdin (heredoc) o con --prompt-archivo.');

  const skillsAbs = res.skills.map((s) => {
    const abs = path.resolve(raiz, expandirHome(s));
    if (!fs.existsSync(abs)) throw new ErrorOrquestador(`La skill "${s}" del rol "${res.rol}" no existe en ${abs}.`);
    return abs;
  });

  const id = nuevoId(res.rol);
  const tarea = previa?.tarea ?? id;
  const bin = ej.bin(registro);
  const args = ej.args(res, skillsAbs, { sandbox: sandboxActivo(registro) });
  const entrada = construirPrompt(res, promptUsuario);
  const rutaWt = res.yolo ? (wtPrevio?.ruta ?? path.join(dirWorktrees(registro, raiz), id)) : null;
  const cwd = rutaWt ?? raiz;

  if (opciones['dry-run']) {
    process.stdout.write(
      `${JSON.stringify({ id, tarea, intento, ejecutor: ej.nombre, bin, cwd, args, resolucion: res }, null, 2)}\n--- prompt ---\n${entrada}`,
    );
    return SALIDA.OK;
  }

  if (!binDisponible(bin)) {
    throw new ErrorOrquestador(`No se encontró "${bin}". Instala ${ej.etiqueta} (${ej.instalar}) o ajusta ${ej.nombre}.bin en el registro.`);
  }
  // Antes de crear el worktree: con modo obligatorio y sin sandbox, se corta aquí sin tocar nada.
  const prueba = envolverEnSandbox(registro, { bin, args, cwd: raiz });
  if (prueba.aviso) avisos.push(prueba.aviso);

  const timeoutMin = ej.config(registro).timeout_min ?? 30;
  const timeoutMs = timeoutMin * 60 * 1000;
  let wt = null;
  if (res.yolo) {
    wt = wtPrevio ?? crearWorktree(registro, raiz, rutaWt, id);
    if (!wtPrevio) {
      guardarMeta(logs, tarea, wt, raiz);
      if (ajustesRepo.preparar.length) {
        const rutaLog = path.join(logs.salidas, `${id}.preparar.log`);
        let preparacion;
        try {
          preparacion = await correrComandos(registro, ajustesRepo.preparar, { wt, raiz, rutaLog, timeoutMs, confiable: true });
        } catch (e) {
          preparacion = [{ comando: ajustesRepo.preparar[0], codigo: 1, cola: [e.message] }];
        }
        const falla = preparacion.find((r) => r.codigo !== 0);
        if (falla) {
          git(['worktree', 'remove', '--force', wt.ruta], raiz, { permitirFallo: true });
          git(['branch', '-D', wt.rama], raiz, { permitirFallo: true });
          throw new ErrorOrquestador(
            `Falló preparar: "${falla.comando}" terminó con código ${falla.codigo}.\n${falla.cola.map((l) => `  ${l}`).join('\n')}\n` +
              `Log: ${rutaLog}. Se eliminó el worktree; revisa preparar en ${ARCHIVO_REPO}.`,
            1,
          );
        }
        const sobrantes = rutasConCambios(wt.ruta);
        if (sobrantes.length) {
          wt.excluir = sobrantes.map((c) => c.ruta);
          guardarMeta(logs, tarea, wt, raiz);
          const versionados = sobrantes.filter((c) => c.estado !== '??').map((c) => c.ruta);
          avisos.push(`preparar dejó ${sobrantes.length} archivo(s) que git no ignora; no se commitean: ${resumirLista(wt.excluir)}.`);
          if (versionados.length) {
            avisos.push(`preparar modificó archivos versionados (${resumirLista(versionados)}): sus cambios nunca se commitearán en esta tarea. Usa comandos que no los modifiquen (p. ej. npm ci).`);
          }
        }
      }
    }
  }

  // Desde aquí el worktree existe: pase lo que pase (error de orq, de git o una señal), la delegación queda
  // registrada, el resumen se imprime y las críticas no se pierden.
  fs.mkdirSync(logs.salidas, { recursive: true });
  const rutaSalida = path.join(logs.salidas, `${id}.log`);
  const rutaPrompt = path.join(logs.salidas, `${id}.prompt.md`);
  const alertas = [];
  const criticas = [];
  let archivos = [];
  let acumulados = [];
  let validacion = null;
  let json = null;
  let sinRespuesta = false;
  let errorInterno = null;
  let ejecucion = { codigo: null, duracion_ms: 0, timeout: false };
  let envuelto = { sandbox: null };
  let interrumpida = null;

  const codigoSalida = () => {
    if (criticas.length) return SALIDA.INTEGRIDAD;
    if (interrumpida || errorInterno) return 1;
    if (ejecucion.timeout) return SALIDA.TIMEOUT;
    if (ejecucion.codigo !== 0 || json?.error || sinRespuesta) return 1;
    return SALIDA.OK;
  };
  let registrado = false;
  const registrar = () => {
    if (registrado) return;
    registrado = true;
    agregarLinea(logs.jsonl, {
      tipo: 'delegacion', id, tarea, fecha: new Date().toISOString(), repo: path.basename(raiz), raiz,
      sensible: sensibilidad.sensible, rol: res.rol, modelo: res.modelo, ejecutor: ej.nombre, slug: res.slug,
      intento: res.intento, effort: res.effort,
      yolo: res.yolo, skills: res.skills, skills_omitidas: res.skills_omitidas, fase,
      worktree: wt ? path.relative(raiz, wt.ruta) : null, rama: wt?.rama ?? null, base: wt?.base ?? null,
      archivos, archivos_acumulados: acumulados, alertas, criticas, avisos,
      sandbox: envuelto.sandbox,
      validacion: validacion && { ok: validacion.ok, comandos: validacion.comandos, log: validacion.log },
      uso: json?.uso ?? null, uso_bruto: json?.usoBruto ?? null, herramientas: json?.herramientas ?? null,
      prompt: rutaPrompt, prompt_chars: entrada.length,
      exit_code: codigoSalida(), codigo_ejecutor: ejecucion.codigo, interrumpida,
      duracion_ms: ejecucion.duracion_ms, salida: rutaSalida,
    });
  };

  const tmp = tmpPrivado();
  try {
    fs.writeFileSync(rutaPrompt, entrada);
    // El sandbox se arma con el worktree ya creado (bwrap solo monta rutas que existen).
    const estadoEj = ej.estado();
    envuelto = envolverEnSandbox(registro, {
      bin,
      args,
      cwd,
      escribibles: [...(wt ? [wt.ruta] : []), ...estadoEj.escritura],
      // Legible aunque esté dentro de una carpeta de sandbox.lectura_denegada: el repo actual (y su .git, que
      // el worktree necesita) y el estado del ejecutor.
      legibles: [raiz, ...(wt ? [wt.ruta] : []), ...estadoEj.escritura],
      protegidas: [...(wt ? [path.join(wt.ruta, '.git')] : []), ...estadoEj.protegidas],
      credencialesExtra: [...SECRETOS_EXTRA, ...ej.credencialesAjenas],
      tmp,
    });

    const archivosAntes = huellaArchivos(raiz, wt?.ruta);
    const gitAntes = huellaGit(raiz, wt?.ruta);

    const lector = ej.lector(res);
    let stderrCola = '';
    ejecucion = await ejecutarProceso(envuelto.bin, envuelto.args, {
      cwd,
      entrada: ej.entrada(entrada),
      env: entornoSandbox({ ...entornoSinSecretos(ej.entorno), TMPDIR: tmp }, envuelto.sandbox),
      rutaSalida,
      timeoutMs,
      alStdout: (d) => (lector ? lector.agregar(d) : process.stdout.write(d)),
      alStderr: (d) => { process.stderr.write(d); stderrCola = (stderrCola + d.toString()).slice(-4000); },
      alInterrumpir: (senal) => {
        interrumpida = senal;
        alertas.push(`orq se interrumpió (${senal}) mientras corría ${ej.etiqueta}: el intento no se commiteó.`);
        registrar();
      },
    });
    json = lector?.terminar() ?? null;

    if (ejecucion.error) alertas.push(ejecucion.error);
    if (ejecucion.timeout) alertas.push(`${ej.etiqueta} superó el timeout de ${timeoutMin} min; se terminó junto con los procesos que lanzó.`);
    else if (ejecucion.codigo !== 0) {
      alertas.push(`${ej.etiqueta} terminó con código ${ejecucion.codigo}.${envuelto.sandbox
        ? ' Si falló al escribir en alguna carpeta, puede ser el sandbox: revisa el log y sandbox.escritura_extra.'
        : ''}`);
    }
    if (json?.error) alertas.push(`${ej.etiqueta} reportó un error: ${json.error}`);
    if (lector && !json.resultado && !ejecucion.timeout) avisos.push(`No llegó el resultado final de ${ej.etiqueta} en JSON: sin datos de tokens.`);
    // Sin texto en la respuesta: agy lo hace cuando un permiso se deniega en headless (el motivo sale por stderr).
    sinRespuesta = Boolean(json?.resultado) && !json.error && !json.texto.trim();
    if (sinRespuesta) {
      const motivo = ultimasLineas(stderrCola, 2).join(' ');
      alertas.push(`${ej.etiqueta} terminó sin respuesta${motivo ? `: ${motivo}` : '.'}`);
    }

    // Integridad. Primero solo archivos: si cambió la configuración de git, no se vuelve a ejecutar git.
    const fa = compararArchivos(archivosAntes, releerHuellaArchivos(archivosAntes));
    criticas.push(...fa.criticas);

    if (!fa.gitComprometido) {
      const fg = compararGit(gitAntes, huellaGit(raiz, wt?.ruta), { ramaEsperada: wt?.rama, soloLectura: !wt });
      criticas.push(...fg.criticas);
      alertas.push(...fg.alertas);

      if (wt && !fg.ramaCambiada) {
        // Un repo anidado no se commitea: como submódulo, git ejecutaría su configuración (filtros) fuera del sandbox.
        const anidados = reposAnidados(wt.ruta);
        if (anidados.length) {
          criticas.push(`Se creó un repo git anidado en el worktree (${resumirLista(anidados)}): no se commiteó, porque git podría ejecutar su configuración fuera del sandbox.`);
        }
        const headAntes = gitAntes.worktree.head;
        commitear(wt, res, id, anidados);
        const submodulos = gitlinksNuevos(wt.ruta, headAntes, 'HEAD');
        if (submodulos.length) criticas.push(`La rama agrega submódulos (${resumirLista(submodulos)}): revísalos antes de cualquier operación de git.`);
        archivos = archivosDelDiff([headAntes, 'HEAD'], wt.ruta);
        acumulados = archivosDelDiff([`${wt.base}..${wt.rama}`], raiz);
        if (!archivos.length && codigoSalida() === SALIDA.OK) alertas.push('El rol es de escritura y no hubo cambios.');
        if (res.max_archivos && acumulados.length > res.max_archivos) {
          alertas.push(`Se modificaron ${acumulados.length} archivos; el límite del rol es ${res.max_archivos}.`);
        }
        const fuera = archivosFueraDeRutas(acumulados, res.rutas_permitidas);
        if (fuera.length) alertas.push(`Archivos fuera de ${res.rutas_permitidas.join(', ')}: ${fuera.join(', ')}.`);
        const config = archivosDeConfiguracion(archivos);
        if (config.length) alertas.push(`El diff toca configuración de agentes, CI o git (${config.join(', ')}): revísala con cuidado antes de integrar.`);

        if (!criticas.length && acumulados.length && ajustesRepo.validar.length) {
          const rutaLog = path.join(logs.salidas, `${id}.validar.log`);
          const resultados = await correrComandos(registro, ajustesRepo.validar, { wt, raiz, rutaLog, timeoutMs });
          validacion = {
            ok: resultados.every((r) => r.codigo === 0),
            comandos: resultados.map(({ cola, ...r }) => r),
            log: rutaLog,
            cola: resultados.find((r) => r.codigo !== 0)?.cola ?? [],
          };
          const restos = descartarCambios(wt);
          if (restos.length) avisos.push(`validar dejó cambios que git no ignora (se descartaron): ${resumirLista(restos)}.`);
          // validar ejecuta código del agente: se vuelve a comprobar lo protegido.
          for (const c of compararArchivos(archivosAntes, releerHuellaArchivos(archivosAntes)).criticas) {
            if (!criticas.includes(c)) criticas.push(`${c} (durante validar)`);
          }
        }
      }
    }
  } catch (e) {
    errorInterno = e;
    alertas.push(`orq falló a mitad de la delegación: ${e.message}`);
  } finally {
    registrar();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const lineas = [];
  if (json) lineas.push('', `--- respuesta de ${ej.etiqueta} ---`, json.texto.trim() || '(sin texto)');
  lineas.push(
    '',
    '--- resumen de la delegación ---',
    `id: ${id} · tarea: ${tarea} · intento ${res.intento}/${res.max_intentos}`,
    `modelo: ${res.modelo}${res.slug ? ` (${res.slug})` : ''} · effort: ${res.effort} · ${ej.etiqueta} · sandbox: ${envuelto.sandbox ?? 'ninguno'}`,
  );
  if (wt) {
    lineas.push(`worktree: ${wt.ruta} (rama ${wt.rama})`);
    lineas.push(`archivos en este intento (${archivos.length}): ${archivos.join(', ') || '—'}`);
    lineas.push(`revisar: git diff ${wt.base.slice(0, 12)}...${wt.rama}`);
  }
  if (json?.uso) {
    const u = json.uso;
    lineas.push(
      `tokens: entrada ${u.entrada ?? '?'} · salida ${u.salida ?? '?'}` +
        `${u.razonamiento ? ` · razonamiento ${u.razonamiento}` : ''}${u.cache ? ` · caché ${u.cache}` : ''}` +
        `${u.costo !== null ? ` · costo ${u.costo}` : ''}`,
    );
  }
  if (validacion) {
    if (validacion.ok) lineas.push(`validar: ✔ ${validacion.comandos.length} comando(s) OK`);
    else {
      const f = validacion.comandos.find((c) => c.codigo !== 0);
      lineas.push(`validar: ✘ "${f.comando}" terminó con código ${f.codigo}${f.timeout ? ' (timeout)' : ''} · log: ${validacion.log}`);
      lineas.push(...validacion.cola.map((l) => `    ${l}`));
    }
  }
  if (res.skills_omitidas.length) {
    const motivo = ej.nombre === 'command_code' ? 'command_code.skills_compatibles no es true' : `${ej.etiqueta} no recibe skills por flag`;
    lineas.push(`aviso: el rol declara skills (${res.skills_omitidas.join(', ')}) pero ${motivo}; resume sus reglas dentro del prompt.`);
  }
  for (const a of avisos) lineas.push(`aviso: ${a}`);
  if (alertas.length) lineas.push(`alertas:\n  - ${alertas.join('\n  - ')}`);
  if (criticas.length) {
    lineas.push(`⚠ INTEGRIDAD: detente y avisa al usuario; no integres, no reintentes y no escales.\n  - ${criticas.join('\n  - ')}`);
  }
  lineas.push(`prompt enviado: ${rutaPrompt}`);
  lineas.push(`registrar revisión: orq revision ${id} aprobado|ajustado|corregido [--nota "..."]`);
  if (wt) lineas.push(`probar en el sandbox: orq validar ${tarea} [-- comando]`);
  if (res.intento < res.max_intentos) {
    lineas.push(`reintento: orq delegar ${res.rol} --continuar ${tarea} <<'PROMPT' ... PROMPT`);
  } else {
    lineas.push(`último intento delegado; si no se aprueba, orq delegar ${res.rol} --continuar ${tarea} indica a qué escalar.`);
  }
  process.stdout.write(`${lineas.join('\n')}\n`);
  return codigoSalida();
}
