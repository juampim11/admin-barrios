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

/**
 * Un documento **dentro de una frase** («DNI 27989690 ya es de …»): el CUIT con guiones, el DNI con su
 * tipo adelante, porque ahí el tipo aclara. Para mostrarlo como dato va `documentoComoDato`.
 */
export function documentoLegible(doc: Documento): string {
  return doc.tipo === "cuit" ? formatearCuit(doc.numero) : `DNI ${doc.numero}`;
}

/**
 * Un documento **como dato** (la ficha, la lista del padrón, «Padrón a una fecha»): el número solo. El
 * CUIT con guiones, el DNI en dígitos — sin el tipo pegado (encargo 17b, punto h: «27989690», no
 * «DNI 27989690»). El rótulo de la columna o del campo ya dice qué es.
 */
export function documentoComoDato(doc: Documento): string {
  return doc.tipo === "cuit" ? formatearCuit(doc.numero) : doc.numero;
}

/**
 * El documento de una persona guardada (`obligado`), como dato. `cuit_cuil` manda cuando está (es el
 * documento de identidad cuando es un CUIT); si no, el número del documento, que la base guarda en
 * dígitos. `null` si la persona no tiene documento cargado.
 */
export function documentoGuardadoComoDato(p: { readonly cuitCuil: string | null; readonly numeroDocumento: string | null }): string | null {
  if (p.cuitCuil) return formatearCuit(p.cuitCuil);
  return p.numeroDocumento ? p.numeroDocumento : null;
}

/**
 * El CUIT **informativo** de un titular (`obligado.cuit_informativo`, `0089`), contra su documento de
 * identidad. Es un dato de quien se identifica con DNI (o sin documento): no decide «es la misma
 * persona» ni tiene unicidad. Si el documento de identidad ya es un CUIT, el informativo no hace
 * falta: el mismo número se **ignora** (`null`) y uno distinto es una **contradicción** que se le
 * muestra a la persona — nunca se guardan dos CUIT distintos para el mismo titular.
 */
export function resolverCuitInformativo(
  documento: Documento | null,
  cuitInformativo: string | null,
): { readonly ok: true; readonly cuit: string | null } | { readonly ok: false; readonly mensaje: string } {
  if (cuitInformativo === null || documento?.tipo !== "cuit") return { ok: true, cuit: cuitInformativo };
  if (documento.numero === cuitInformativo) return { ok: true, cuit: null };
  return {
    ok: false,
    // Sin el número: el mensaje va al log del servidor, y el dato ya está en la ficha.
    mensaje: "Este titular ya se identifica con un CUIT, y no es este: el CUIT informativo es para quien se identifica con DNI. Dejalo vacío.",
  };
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
