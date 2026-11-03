/**
 * Las identificaciones que se cargan en el padrón y en el alta de un barrio: CBU, alias, CUIT/CUIL y
 * documento. Determinístico, sin E/S. **Es la misma regla que valida la base** (`app.cbu_valido`,
 * migración `0065`): la pantalla rechaza antes para que el mensaje caiga en el campo, y la base vuelve
 * a mirar para que ningún camino la saltee.
 *
 * `packages/documentos/src/cobranza/cbu.ts` reexporta los verificadores de acá: una sola copia de la
 * aritmética del CBU en todo el repo.
 */

const PESOS_BLOQUE_1 = [7, 1, 3, 9, 7, 1, 3] as const;
const PESOS_BLOQUE_2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3] as const;

function digitoVerificador(digitos: string, pesos: readonly number[]): number {
  // Sin esto, un carácter no numérico da `NaN` en silencio y el verificador sale `NaN`: el CBU
  // "pasaría" cualquier comparación por desigualdad y nadie se enteraría.
  if (digitos.length !== pesos.length || !/^\d+$/.test(digitos)) {
    throw new Error(`el bloque del CBU tiene que ser ${pesos.length} dígitos, y llegó "${digitos}"`);
  }
  const suma = pesos.reduce((acum, peso, i) => acum + peso * Number(digitos[i]), 0);
  return (10 - (suma % 10)) % 10;
}

/** Verificador del bloque 1 (banco + sucursal): posición 8 del CBU. */
export function verificadorBloque1(primerosSiete: string): number {
  return digitoVerificador(primerosSiete, PESOS_BLOQUE_1);
}

/** Verificador del bloque 2 (cuenta): posición 22 del CBU. */
export function verificadorBloque2(treceDigitos: string): number {
  return digitoVerificador(treceDigitos, PESOS_BLOQUE_2);
}

/** `true` si el CBU tiene 22 dígitos y **los dos** verificadores son correctos. */
export function cbuValido(cbu: string): boolean {
  if (!/^\d{22}$/.test(cbu)) return false;
  return (
    Number(cbu[7]) === verificadorBloque1(cbu.slice(0, 7)) &&
    Number(cbu[21]) === verificadorBloque2(cbu.slice(8, 21))
  );
}

/** Lo que una persona tipea («0000003 1000…», con espacios o guiones) → los 22 dígitos, o `null`. */
export function normalizarCbu(texto: string | null | undefined): string | null {
  const d = (texto ?? "").replace(/[\s.-]/g, "");
  return cbuValido(d) ? d : null;
}

/**
 * Alias CBU: de 6 a 20 caracteres, letras, números, punto y guion. Se guarda como se escribió y se
 * compara sin mayúsculas (el sistema bancario no las distingue).
 */
export function normalizarAlias(texto: string | null | undefined): string | null {
  const a = (texto ?? "").trim();
  return /^[A-Za-z0-9.-]{6,20}$/.test(a) ? a : null;
}

/** CUIT o CUIL de 11 dígitos con su verificador (sin guiones ni espacios); `null` si no es válido. */
export function normalizarCuit(texto: string | null | undefined): string | null {
  const d = (texto ?? "").replace(/[\s.-]/g, "");
  if (!/^\d{11}$/.test(d)) return null;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const r = 11 - (pesos.reduce((s, p, i) => s + p * Number(d[i]), 0) % 11);
  const dv = r === 11 ? 0 : r === 10 ? -1 : r;
  return dv === Number(d[10]) ? d : null;
}

/** «20111111112» → «20-11111111-2», como se muestra en toda la aplicación. */
export function formatearCuit(cuit: string): string {
  return /^\d{11}$/.test(cuit) ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit;
}

/**
 * «CUIT, CUIL o DNI» en un solo campo, como lo pide la maqueta: 11 dígitos es CUIT/CUIL (y tiene que
 * tener el verificador bien); 7 u 8 dígitos es DNI. Cualquier otra cosa es un error que se le muestra
 * a la persona — nunca se adivina.
 */
export type Documento = { readonly tipo: "cuit"; readonly numero: string } | { readonly tipo: "dni"; readonly numero: string };

export function leerDocumento(texto: string | null | undefined): Documento | "invalido" | null {
  const d = (texto ?? "").replace(/[\s.-]/g, "");
  if (d === "") return null;
  if (/^\d{11}$/.test(d)) {
    const cuit = normalizarCuit(d);
    return cuit ? { tipo: "cuit", numero: cuit } : "invalido";
  }
  if (/^\d{7,8}$/.test(d)) return { tipo: "dni", numero: d };
  return "invalido";
}

/** Para mostrar un documento leído: el CUIT con guiones, el DNI tal cual. */
export function documentoLegible(doc: Documento): string {
  return doc.tipo === "cuit" ? formatearCuit(doc.numero) : `DNI ${doc.numero}`;
}

/**
 * Cuándo dos nombres son la misma persona para la planilla: sin mayúsculas, tildes, signos ni orden de
 * las palabras («Pérez, Ana María» = «ana maria perez»). Lo usa la importación del padrón para decir
 * «a revisar» cuando un CUIT ya registrado viene con otro nombre.
 */
export function nombreComparable(nombre: string | null | undefined): string {
  return (nombre ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "")
    .sort()
    .join(" ");
}

export function nombresIguales(a: string | null | undefined, b: string | null | undefined): boolean {
  return nombreComparable(a) === nombreComparable(b);
}
