// Lector del stream NDJSON de `cmd -p --output-format json`:
//   {"type":"event","event":{"type":"tool_running","toolName":"read_file",...}}
//   {"type":"result","subtype":"success","usage":{...},"durationMs":8421,"finalText":"..."}   (siempre la última)

import { extraerUso } from './registro.mjs';

export function crearLectorJson() {
  let pendiente = '';
  let resultado = null;
  const herramientas = {};

  const procesar = (linea) => {
    if (!linea.trim()) return;
    let obj;
    try {
      obj = JSON.parse(linea);
    } catch {
      return; // líneas que no son JSON (avisos) se ignoran; quedan en el log crudo
    }
    if (obj?.type === 'result') resultado = obj;
    else if (obj?.type === 'event' && obj.event?.type === 'tool_running' && obj.event.toolName) {
      herramientas[obj.event.toolName] = (herramientas[obj.event.toolName] ?? 0) + 1;
    }
  };

  return {
    agregar(trozo) {
      pendiente += trozo.toString();
      const lineas = pendiente.split('\n');
      pendiente = lineas.pop();
      for (const l of lineas) procesar(l);
    },
    terminar() {
      procesar(pendiente);
      pendiente = '';
      return {
        resultado,
        texto: resultado?.finalText ?? '',
        error: resultado?.subtype === 'error' ? (resultado.error ?? 'error sin detalle') : null,
        subtipo: resultado?.subtype ?? null,
        estado: resultado?.subtype ?? null,
        uso: resultado ? extraerUso(resultado.usage) : null,
        usoBruto: resultado?.usage ?? null,
        herramientas: Object.keys(herramientas).length ? herramientas : null,
      };
    },
  };
}
