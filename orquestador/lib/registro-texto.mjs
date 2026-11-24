// Edición del registro como texto, sin dependencias (lo usa también instalar.mjs antes de instalar `yaml`).
//
// `orq verificar --guardar` solo cambia command_code.skills_compatibles y command_code.salida_json.
// Reescribirlo con la librería YAML reformatea todo el archivo (pliega textos largos, despliega listas,
// mueve comentarios); aquí se cambia solo la línea de cada clave y el resto queda byte a byte igual.
// Así el instalador puede reconocer un registro "sin modificar" ignorando los ajustes del usuario.

import crypto from 'node:crypto';

/** Claves que escribe la Fase 0. */
export const CLAVES_FASE0 = ['skills_compatibles', 'salida_json'];

/**
 * Ajustes del usuario: no cuentan como modificación del registro (el instalador lo sigue actualizando)
 * y su valor se conserva al actualizar. Solo si están en una línea (`clave: valor`); una lista en varias
 * líneas sí cuenta como modificación.
 */
export const AJUSTES_USUARIO = [
  ...CLAVES_FASE0.map((c) => ['command_code', c]),
  ['antigravity', 'permitir_cuenta_personal'],
  ['sandbox', 'lectura_denegada'],
  ['sandbox', 'lectura_extra'],
];

/** Rango de líneas [inicio, fin) del bloque de una sección de primer nivel, o null si no existe. */
function bloque(lineas, seccion) {
  const inicio = lineas.findIndex((l) => l.replace(/\s+#.*$/, '').trimEnd() === `${seccion}:`);
  if (inicio === -1) return null;
  let fin = inicio + 1;
  while (fin < lineas.length && (lineas[fin].trim() === '' || /^\s/.test(lineas[fin]) || lineas[fin].startsWith('#'))) fin++;
  // las líneas en blanco y comentarios sueltos al final pertenecen a lo que sigue
  while (fin > inicio + 1 && (lineas[fin - 1].trim() === '' || lineas[fin - 1].startsWith('#'))) fin--;
  return { inicio, fin };
}

const reClave = (clave) => new RegExp(`^(\\s+${clave}:)([^#\\n]*?)(\\s+#.*)?$`);

/** Valor (texto de una línea) de `seccion.clave`, o undefined si no está. */
export function leerClave(texto, seccion, clave) {
  const lineas = texto.split('\n');
  const b = bloque(lineas, seccion);
  if (!b) return undefined;
  for (let i = b.inicio + 1; i < b.fin; i++) {
    const m = lineas[i].match(reClave(clave));
    if (m) return m[2].trim();
  }
  return undefined;
}

/**
 * Fija `seccion.clave: valor` cambiando solo esa línea (conserva su comentario). Si la clave no existe,
 * la agrega al final del bloque con la sangría de sus hermanas. Lanza si la sección no existe.
 */
export function fijarClave(texto, seccion, clave, valor) {
  const lineas = texto.split('\n');
  const b = bloque(lineas, seccion);
  if (!b) throw new Error(`No encontré la sección "${seccion}:" en el registro.`);
  for (let i = b.inicio + 1; i < b.fin; i++) {
    const m = lineas[i].match(reClave(clave));
    if (m) {
      lineas[i] = `${m[1]} ${valor}${m[3] ?? ''}`;
      return lineas.join('\n');
    }
  }
  const hermana = lineas.slice(b.inicio + 1, b.fin).find((l) => /^\s+\S/.test(l) && !l.trim().startsWith('#'));
  const sangria = hermana ? hermana.match(/^\s+/)[0] : '  ';
  lineas.splice(b.fin, 0, `${sangria}${clave}: ${valor}`);
  return lineas.join('\n');
}

/**
 * sha256 del registro sin las líneas de los ajustes del usuario: un registro cuya única diferencia con la
 * plantilla instalada son esos ajustes (o el resultado de `orq verificar --guardar`) cuenta como no modificado.
 */
export function hashRegistro(texto) {
  const lineas = texto.split('\n');
  const fuera = new Set();
  for (const [seccion, clave] of AJUSTES_USUARIO) {
    const b = bloque(lineas, seccion);
    if (!b) continue;
    for (let i = b.inicio + 1; i < b.fin; i++) {
      const m = lineas[i].match(reClave(clave));
      if (m && m[2].trim()) fuera.add(i); // valor en la misma línea; una lista en varias líneas sí cuenta
    }
  }
  return crypto.createHash('sha256').update(lineas.filter((_, i) => !fuera.has(i)).join('\n')).digest('hex');
}

/**
 * Copia a `nuevo` los ajustes que el usuario tenga en `anterior`:
 * - resultados de la Fase 0 y permitir_cuenta_personal: si son true o false;
 * - lectura_denegada y lectura_extra: si no están vacías (vacía = toma el valor por defecto de la plantilla nueva).
 */
export function conservarAjustes(anterior, nuevo) {
  let t = nuevo;
  for (const [seccion, clave] of AJUSTES_USUARIO) {
    const valor = leerClave(anterior, seccion, clave);
    if (valor === undefined) continue;
    const esLista = clave === 'lectura_denegada' || clave === 'lectura_extra';
    const conservar = esLista ? /^\[.*\S.*\]$/.test(valor) : valor === 'true' || valor === 'false';
    if (!conservar) continue;
    try {
      t = fijarClave(t, seccion, clave, valor);
    } catch { /* la plantilla nueva ya no tiene esa sección */ }
  }
  return t;
}

/** Compatibilidad con el nombre anterior. */
export const conservarFase0 = conservarAjustes;
