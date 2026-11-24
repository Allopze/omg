// Lector del stream NDJSON de `cmd -p --output-format json`:
//   {"type":"event","event":{"type":"tool_running","toolName":"read_file",...}}
//   {"type":"result","subtype":"success","usage":{...},"durationMs":8421,"finalText":"..."}   (siempre la última)

import { StringDecoder } from 'node:string_decoder';
import { extraerUso } from './registro.mjs';

const MAX_STDOUT_COLA = 10;

export function crearLectorJson({ alEvento } = {}) {
  const decoder = new StringDecoder('utf8');
  let pendiente = '';
  let resultado = null;
  let errorEvento = null;
  const herramientas = {};
  const stdoutCola = [];

  const procesar = (linea) => {
    const limpia = linea.trim();
    if (!limpia) return;
    let obj;
    try {
      obj = JSON.parse(limpia);
    } catch {
      stdoutCola.push(limpia);
      if (stdoutCola.length > MAX_STDOUT_COLA) stdoutCola.shift();
      return; // líneas que no son JSON (avisos) quedan en stdoutCola y en el log crudo
    }
    if (obj?.type === 'result') resultado = obj;
    else if (obj?.type === 'event' && obj.event?.type === 'tool_running' && obj.event.toolName) {
      herramientas[obj.event.toolName] = (herramientas[obj.event.toolName] ?? 0) + 1;
      alEvento?.({ tipo: 'herramienta', nombre: obj.event.toolName });
    } else if (obj?.type === 'error') {
      const msg = obj.error?.message || obj.error || obj.message;
      errorEvento = typeof msg === 'string' ? msg : (msg ? JSON.stringify(msg) : 'error sin detalle');
    }
  };

  return {
    agregar(trozo) {
      if (trozo === undefined || trozo === null) return;
      pendiente += decoder.write(trozo);
      const lineas = pendiente.split('\n');
      pendiente = lineas.pop();
      for (const l of lineas) procesar(l);
    },
    terminar() {
      pendiente += decoder.end();
      const lineas = pendiente.split('\n');
      pendiente = '';
      for (const l of lineas) procesar(l);

      const texto = typeof resultado?.finalText === 'string'
        ? resultado.finalText
        : String(resultado?.finalText ?? '');
      let error = null;
      if (resultado?.subtype && resultado.subtype !== 'success') {
        const detalle = resultado.error ?? resultado.subtype;
        error = typeof detalle === 'string' ? detalle : (detalle?.message || JSON.stringify(detalle));
      } else if (!resultado && errorEvento) {
        error = errorEvento;
      }

      return {
        resultado,
        texto,
        error,
        subtipo: resultado?.subtype ?? null,
        estado: resultado?.subtype ?? null,
        uso: resultado ? extraerUso(resultado.usage) : null,
        usoBruto: resultado?.usage ?? null,
        herramientas: Object.keys(herramientas).length ? herramientas : null,
        stdoutCola,
      };
    },
  };
}
