import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const GRACIA_MS = 5000;
const ESPERA_STDIO_MS = 1000;

function grupoVivo(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function senalGrupo(pid, senal) {
  try {
    process.kill(-pid, senal);
  } catch { /* el grupo ya no existe */ }
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM al grupo y, si algo sigue vivo tras la gracia, SIGKILL. */
async function terminarGrupo(pid, graciaMs = GRACIA_MS) {
  if (!grupoVivo(pid)) return;
  senalGrupo(pid, 'SIGTERM');
  const limite = Date.now() + graciaMs;
  while (Date.now() < limite) {
    if (!grupoVivo(pid)) return;
    await pausa(100);
  }
  senalGrupo(pid, 'SIGKILL');
}

/**
 * Ejecuta un proceso en su propio grupo de procesos.
 *
 * - Por timeout, termina el grupo completo (el agente y todo lo que lanzó).
 * - Cuando el proceso principal sale, también termina el grupo: un servidor o watcher que haya
 *   quedado corriendo no deja colgado al orquestador manteniendo abierto el stdout.
 * - Si orq recibe SIGINT/SIGTERM/SIGHUP mientras espera, termina el grupo antes de resolver.
 *
 * Devuelve { codigo, duracion_ms, timeout, interrumpida, senal, error? }.
 */
export function ejecutarProceso(bin, args, {
  cwd, entrada = '', env = process.env, rutaSalida = null, timeoutMs, alStdout, alStderr, alInterrumpir: avisar,
} = {}) {
  return new Promise((resolve) => {
    if (rutaSalida) fs.mkdirSync(path.dirname(rutaSalida), { recursive: true });
    const archivo = rutaSalida ? fs.createWriteStream(rutaSalida, { flags: 'a' }) : null;
    const inicio = Date.now();
    let porTimeout = false;
    let resuelto = false;
    let temporizador = null;
    let espera = null;
    let interrumpida = null;

    const hijo = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

    const SENALES = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const terminar = async (resultado, graciaMs = 2000) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      clearTimeout(espera);
      for (const s of SENALES) process.off(s, alInterrumpir);
      if (hijo.pid) await terminarGrupo(hijo.pid, graciaMs);
      hijo.stdout?.destroy();
      hijo.stderr?.destroy();
      const fin = () => resolve({
        ...resultado,
        interrumpida: resultado.interrumpida ?? interrumpida ?? null,
        senal: resultado.senal ?? null,
        duracion_ms: Date.now() - inicio,
      });
      if (archivo) archivo.end(fin);
      else fin();
    };

    // `avisar` (síncrono) deja constancia antes de terminar el grupo y resolver limpiamente.
    const alInterrumpir = (senal) => {
      if (resuelto) return;
      interrumpida = senal;
      try {
        avisar?.(senal);
      } catch { /* continuar con el cierre */ }
      terminar({
        codigo: senal === 'SIGINT' ? 130 : 143,
        timeout: false,
        interrumpida: senal,
        senal,
      }, 1500);
    };
    for (const s of SENALES) process.on(s, alInterrumpir);

    if (timeoutMs > 0) {
      temporizador = setTimeout(() => {
        porTimeout = true;
        if (hijo.pid) terminarGrupo(hijo.pid);
      }, Math.min(timeoutMs, 2_147_483_647));
    }

    hijo.stdout.on('data', (d) => { archivo?.write(d); alStdout?.(d); });
    hijo.stderr.on('data', (d) => { archivo?.write(d); alStderr?.(d); });

    hijo.on('error', (e) => {
      terminar({
        codigo: 2,
        timeout: false,
        interrumpida: interrumpida ?? null,
        senal: null,
        error: e.code === 'ENOENT' ? `No se encontró "${bin}".` : e.message,
        codigoError: e.code,
      });
    });
    hijo.on('exit', (codigo, senal) => {
      const resultado = {
        codigo: porTimeout ? 124 : codigo ?? 1,
        timeout: porTimeout,
        interrumpida: interrumpida ?? null,
        senal: senal ?? null,
      };
      // Esperar un momento a que se vacíe el stdout, pero no a los nietos que lo mantienen abierto.
      espera = setTimeout(() => terminar(resultado), ESPERA_STDIO_MS);
      hijo.once('close', () => { clearTimeout(espera); terminar(resultado); });
    });

    hijo.stdin.on('error', () => {});
    hijo.stdin.end(entrada);
  });
}
