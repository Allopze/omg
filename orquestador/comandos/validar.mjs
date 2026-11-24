// orq validar <tarea> [-- comando ...]
//
// Corre los comandos `validar` del repo (o el comando que pases después de --) en el worktree de la tarea,
// dentro del sandbox, con un temporal propio y sin secretos en el entorno. Es la forma de ejecutar tests,
// builds o scripts sobre código que escribió otro modelo sin darle tus permisos.
//
//   orq validar <tarea>                          los comandos `validar` de .claude/orquestador.yaml
//   orq validar <tarea> -- npm test              un comando (cada argumento se cita para el shell)
//   orq validar <tarea> -- 'npm test && npm run lint'   un solo argumento: se pasa tal cual al shell
//
// No commitea: lo que deje sin ignorar en git se descarta. Códigos: 0 todo OK · 1 algo falló · 5 integridad.

import path from 'node:path';
import { ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { registroEfectivo, rutasLogs, ARCHIVO_REPO } from '../lib/config.mjs';
import { raizRepo, leerJsonl, nuevoId } from '../lib/util.mjs';
import { buscarTarea } from '../lib/tareas.mjs';
import { worktreeDeTarea, correrComandos, descartarCambios } from '../lib/worktree-tarea.mjs';
import { huellaArchivos, releerHuellaArchivos, compararArchivos } from '../lib/integridad.mjs';

const USO = "Uso: orq validar <tarea> [-- comando ...]   (sin comando, corre los `validar` del repo)";
const citar = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

export async function ejecutar(argv) {
  const corte = argv.indexOf('--');
  const propios = corte === -1 ? argv : argv.slice(0, corte);
  const pedido = corte === -1 ? null : argv.slice(corte + 1);
  if (propios.length !== 1 || (pedido && !pedido.length)) throw new ErrorOrquestador(USO);

  const raiz = raizRepo();
  const logs = rutasLogs();
  const { registro, repo } = registroEfectivo(raiz);
  const previa = buscarTarea(leerJsonl(logs.jsonl), raiz, propios[0]);
  if (!previa) throw new ErrorOrquestador(`No hay una tarea "${propios[0]}" en este repo. orq estado lista las tareas abiertas.`);
  if (!previa.intentos.some((e) => e.worktree)) {
    throw new ErrorOrquestador(`La tarea ${previa.tarea} es de un rol de solo lectura: no tiene worktree que validar.`);
  }
  const wt = worktreeDeTarea(raiz, logs, previa);

  let comandos = repo.validar;
  if (pedido) comandos = [pedido.length === 1 ? pedido[0] : pedido.map(citar).join(' ')];
  if (!comandos.length) throw new ErrorOrquestador(`El repo no declara comandos validar en ${ARCHIVO_REPO}: pásalo después de --.`);

  const rutaLog = path.join(logs.salidas, `${nuevoId('validar')}.log`);
  const timeoutMs = (registro.command_code?.timeout_min ?? 30) * 60 * 1000;
  const antes = huellaArchivos(raiz, wt.ruta);
  const resultados = await correrComandos(registro, comandos, { wt, raiz, rutaLog, timeoutMs });
  const restos = descartarCambios(wt);
  const { criticas } = compararArchivos(antes, releerHuellaArchivos(antes));

  const lineas = [`worktree: ${wt.ruta} (rama ${wt.rama}) · sandbox: ${resultados[0]?.sandbox ?? 'ninguno'}`];
  for (const r of resultados) {
    lineas.push(`${r.codigo === 0 ? '✔' : '✘'} ${r.comando} — código ${r.codigo}${r.timeout ? ' (timeout)' : ''}, ${(r.duracion_ms / 1000).toFixed(1)} s`);
    lineas.push(...r.cola.map((l) => `    ${l}`));
  }
  if (restos.length) lineas.push(`aviso: quedaron cambios que git no ignora y se descartaron: ${restos.join(', ')}`);
  if (criticas.length) lineas.push(`⚠ INTEGRIDAD: detente y avisa al usuario.\n  - ${criticas.join('\n  - ')}`);
  lineas.push(`log completo: ${rutaLog}`);
  process.stdout.write(`${lineas.join('\n')}\n`);
  if (criticas.length) return SALIDA.INTEGRIDAD;
  return resultados.every((r) => r.codigo === 0) ? SALIDA.OK : 1;
}
