/**
 * La planilla del padrón (T3, pantalla 4): leerla, decidir qué hace cada unidad contra lo que ya hay
 * en el barrio, y exportarla con las mismas columnas. Determinístico, sin E/S.
 *
 * El patrón (vista previa, errores por fila, «a revisar» que se decide en pantalla, todo o nada) es
 * el de la importación de padrón de otro sistema de la casa, portado a este modelo:
 *
 *  - **Una fila por titular.** Varios titulares de la misma unidad van en filas seguidas con la misma
 *    manzana y lote; los datos de la unidad (superficie, estado, nomenclatura, cuenta, saldo) van en
 *    la primera, y una sola marca `recibe_boleta`.
 *  - Una unidad que no existe es un **alta**; una que existe se **corrige** (superficie, estado,
 *    nomenclatura, cuenta, saldo inicial si todavía no se usó, y el contacto de sus titulares).
 *  - **El cambio de titular no se hace por planilla**: tiene fecha e historial, y se hace desde la
 *    ficha. Una fila con otra persona en una unidad que ya existe es un error.
 *  - **«A revisar»**: un CUIT o DNI ya registrado en el barrio con otro nombre (sin mayúsculas, tildes
 *    ni orden). Se decide en pantalla: «Es la misma persona» (se usa la registrada) o «No es» (la
 *    fila queda con error: hay que corregir el documento).
 *  - Un mismo CUIT en varias unidades no es un error: la misma persona puede tener varios lotes.
 *  - `cbu_unidad` y `alias_unidad` solo existen si el barrio cobra con una cuenta por unidad.
 *  - `numero_accion` y las cuatro del residente (encargo 15, `0078`) son datos de la unidad, opcionales:
 *    van en la primera fila. El número de acción es único en el barrio. **El residente es solo un
 *    dato**: la boleta, el envío y la deuda van siempre al propietario.
 *
 * Con un error en cualquier fila, o una fila «a revisar» sin decidir, no se confirma nada.
 */

import { type Documento, documentoLegible, leerDocumento, normalizarAlias, normalizarCbu, nombresIguales } from "./cuentas.ts";
import { type CaracterResidente, type EstadoUnidad, type TipoObligado, etiquetaUnidad } from "./barrio.ts";

export const MAX_FILAS_PADRON = 5000;

export const COLUMNAS_PADRON = [
  "manzana",
  "lote",
  "superficie_m2",
  "estado",
  "nomenclatura",
  "titular",
  "caracter",
  "cuit_o_dni",
  "recibe_boleta",
  "mail",
  "telefono",
  "cbu_unidad",
  "alias_unidad",
  "saldo_inicial",
  // Encargo 15 (`0078`). Al final: el lector va por nombre de columna, y una planilla de antes (sin
  // estas cinco) se sigue importando igual.
  "numero_accion",
  "residente",
  "residente_caracter",
  "residente_telefono",
  "residente_mail",
] as const;
export type ColumnaPadron = (typeof COLUMNAS_PADRON)[number];

/** Las columnas de la planilla de ESTE barrio: sin las de la cuenta si cobra con una cuenta única. */
export function columnasDelPadron(cuentaPorUnidad: boolean): readonly ColumnaPadron[] {
  return cuentaPorUnidad ? COLUMNAS_PADRON : COLUMNAS_PADRON.filter((c) => c !== "cbu_unidad" && c !== "alias_unidad");
}

/** Una planilla que no se puede leer entera (sin encabezado, vacía, demasiado grande). */
export class PlanillaInvalida extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "PlanillaInvalida";
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// CSV
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un CSV (RFC-4180, con comillas) en filas de celdas. El separador es `;` o `,`, el que más aparezca
 * en el encabezado (Excel en castellano guarda con `;`). Sin BOM.
 */
export function filasDeCsv(texto: string): string[][] {
  const limpio = texto.replace(/^﻿/, "");
  const primera = limpio.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const sep = (primera.match(/;/g)?.length ?? 0) >= (primera.match(/,/g)?.length ?? 0) ? ";" : ",";
  const filas: string[][] = [];
  let campos: string[] = [];
  let actual = "";
  let entre = false;
  for (let i = 0; i < limpio.length; i++) {
    const ch = limpio[i]!;
    if (entre) {
      if (ch === '"' && limpio[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (ch === '"') entre = false;
      else actual += ch;
    } else if (ch === '"' && actual === "") entre = true;
    else if (ch === sep) {
      campos.push(actual);
      actual = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && limpio[i + 1] === "\n") i++;
      campos.push(actual);
      filas.push(campos);
      campos = [];
      actual = "";
    } else actual += ch;
  }
  if (actual !== "" || campos.length > 0) {
    campos.push(actual);
    filas.push(campos);
  }
  return filas;
}

/** Una celda que sale a un CSV: entre comillas si hace falta. (El saneado de fórmulas va aparte.) */
function celdaCsv(valor: string): string {
  return /[;"\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

export function csvDeFilas(filas: readonly (readonly string[])[]): string {
  return filas.map((f) => f.map(celdaCsv).join(";")).join("\r\n") + "\r\n";
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lectura
// ────────────────────────────────────────────────────────────────────────────────────────────────

const sinAcentos = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** «Baldío», «en construcción», «Construida» → el valor del padrón. */
function leerEstado(texto: string): EstadoUnidad | "invalido" | null {
  const t = sinAcentos(texto).replace(/\s+/g, "_");
  if (t === "") return null;
  if (t === "baldio") return "baldio";
  if (t === "en_construccion") return "en_construccion";
  if (t === "construida" || t === "construido") return "construido";
  return "invalido";
}

/** «Propietaria», «poseedor» → el carácter del titular. Vacío = propietario. */
function leerCaracter(texto: string): TipoObligado | "invalido" {
  const t = sinAcentos(texto);
  if (t === "" || t === "propietario" || t === "propietaria") return "propietario";
  if (t === "poseedor" || t === "poseedora") return "poseedor";
  if (t === "usufructuario" || t === "usufructuaria") return "usufructuario";
  if (t === "tenedor" || t === "tenedora") return "tenedor";
  return "invalido";
}

/** «Inquilina», «residente», «otro» → el carácter del residente. Vacío = sin carácter. */
function leerCaracterResidente(texto: string): CaracterResidente | "invalido" | null {
  const t = sinAcentos(texto);
  if (t === "") return null;
  if (t === "inquilino" || t === "inquilina") return "inquilino";
  if (t === "residente") return "residente";
  if (t === "otro" || t === "otra") return "otro";
  return "invalido";
}

function leerSiNo(texto: string): boolean {
  return ["si", "x", "1", "true", "s"].includes(sinAcentos(texto));
}

/**
 * Un número de la planilla («612,00», «48.200,00», «612.5» o «48200») → «612.00». `null` si no es un
 * número no negativo con hasta `decimales` decimales. Excel en castellano usa coma decimal; una celda
 * numérica de un XLSX llega con punto.
 */
export function leerNumeroDePlanilla(texto: string, decimales = 2): string | null {
  let t = texto.trim().replace(/\s|\$/g, "");
  if (t === "") return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimales}}))?$`).exec(t);
  if (!m) return null;
  return `${BigInt(m[1]!).toString()}.${(m[2] ?? "").padEnd(decimales, "0")}`;
}

const MAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TELEFONO = /^\+?[0-9 ()-]{6,25}$/;

export type TitularLeido = {
  readonly fila: number;
  readonly nombre: string;
  readonly caracter: TipoObligado;
  readonly documento: Documento | null;
  readonly recibeBoleta: boolean;
  readonly mail: string | null;
  readonly telefono: string | null;
};

export type UnidadLeida = {
  /** La primera fila de la unidad en la planilla (las filas cuentan desde el encabezado = 1). */
  readonly fila: number;
  readonly filas: readonly number[];
  readonly manzana: string;
  readonly lote: string;
  readonly etiqueta: string;
  readonly superficie: string | null;
  readonly estado: EstadoUnidad | null;
  readonly nomenclatura: string | null;
  readonly cbu: string | null;
  readonly alias: string | null;
  readonly saldoInicial: string | null;
  /** `null` = la columna vino vacía (o no vino): no se cambia. */
  readonly numeroAccion: string | null;
  /** El residente informativo; `null` = no vino. */
  readonly residente: ResidenteDeUnidad | null;
  readonly titulares: readonly TitularLeido[];
};

/** El residente o inquilino informativo de una unidad (`0078`). No es un obligado. */
export type ResidenteDeUnidad = {
  readonly nombre: string;
  readonly caracter: CaracterResidente | null;
  readonly telefono: string | null;
  readonly mail: string | null;
};

export type LecturaDeUnidad =
  | ({ readonly ok: true } & UnidadLeida)
  | { readonly ok: false; readonly fila: number; readonly filas: readonly number[]; readonly etiqueta: string | null; readonly error: string };

const clave = (manzana: string, lote: string) => `${manzana.trim().toUpperCase()}|${lote.trim().toUpperCase()}`;

/**
 * Lee las filas (encabezado + datos, ya sea de un CSV o de un XLSX) y las agrupa por unidad. Un
 * archivo sin `manzana`/`lote` en el encabezado, sin filas o con más de 5.000 rechaza el archivo
 * entero; el resto de los problemas son errores **por unidad**, para mostrarlos en la vista previa.
 */
export function leerPlanillaPadron(filasCrudas: readonly (readonly string[])[], opciones: { readonly cuentaPorUnidad: boolean }): LecturaDeUnidad[] {
  const [encabezado, ...resto] = filasCrudas;
  const nombres = (encabezado ?? []).map((c) => sinAcentos(c).replace(/\s+/g, "_"));
  if (!nombres.includes("manzana") || !nombres.includes("lote")) {
    throw new PlanillaInvalida("La planilla no tiene las columnas manzana y lote: bajá la plantilla y respetá el encabezado.");
  }
  const datos = resto
    .map((campos, i) => ({ numero: i + 2, campos }))
    .filter((r) => r.campos.some((c) => c.trim() !== ""));
  if (datos.length === 0) throw new PlanillaInvalida("La planilla no tiene filas.");
  if (datos.length > MAX_FILAS_PADRON) {
    throw new PlanillaInvalida("La planilla tiene más de 5.000 filas: partila en varias.");
  }
  // El apóstrofo que pone el saneado anti-fórmula al exportar («'+54 351…») se saca al volver a
  // leer: lo exportado se tiene que poder importar tal cual.
  const col = (n: ColumnaPadron, c: readonly string[]) => {
    const i = nombres.indexOf(n);
    return i >= 0 ? (c[i] ?? "").trim().replace(/^'(?=[=+\-@])/, "") : "";
  };

  // Agrupar: las filas de una unidad van seguidas. Una unidad que reaparece más abajo es un error.
  type Grupo = { clave: string; filas: { numero: number; campos: readonly string[] }[] };
  const grupos: Grupo[] = [];
  const vistas = new Map<string, Grupo>();
  const repetidas = new Map<string, number[]>();
  for (const r of datos) {
    const k = clave(col("manzana", r.campos), col("lote", r.campos));
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.clave === k) {
      ultimo.filas.push(r);
      continue;
    }
    const previo = vistas.get(k);
    if (previo) {
      repetidas.set(k, [...(repetidas.get(k) ?? [previo.filas[0]!.numero]), r.numero]);
      previo.filas.push(r);
      continue;
    }
    const g = { clave: k, filas: [r] };
    grupos.push(g);
    vistas.set(k, g);
  }

  return grupos.map((g): LecturaDeUnidad => {
    const primera = g.filas[0]!;
    const filas = g.filas.map((f) => f.numero);
    const manzana = col("manzana", primera.campos);
    const lote = col("lote", primera.campos);
    const etiqueta = manzana && lote ? etiquetaUnidad(manzana, lote) : null;
    const error = (fila: number, mensaje: string): LecturaDeUnidad => ({ ok: false, fila, filas, etiqueta, error: mensaje });

    if (!manzana || !lote) return error(primera.numero, "Falta la manzana o el lote: son obligatorios.");
    if (manzana.length > 20 || lote.length > 20) return error(primera.numero, "La manzana y el lote tienen hasta 20 caracteres.");
    const rep = repetidas.get(g.clave);
    if (rep) return error(rep[1]!, `La unidad ${etiqueta} está dos veces en la planilla (filas ${rep.join(" y ")}): sus filas van seguidas.`);

    // Los datos de la unidad, en la primera fila; las siguientes solo traen titulares.
    for (const f of g.filas.slice(1)) {
      const conDatos = (
        [
          "superficie_m2",
          "estado",
          "nomenclatura",
          "cbu_unidad",
          "alias_unidad",
          "saldo_inicial",
          "numero_accion",
          "residente",
          "residente_caracter",
          "residente_telefono",
          "residente_mail",
        ] as const
      ).some(
        (c) => col(c, f.campos) !== "",
      );
      if (conDatos) {
        return error(
          f.numero,
          `La unidad ${etiqueta} está dos veces en la planilla (filas ${primera.numero} y ${f.numero}): los datos de la unidad van solo en su primera fila; las siguientes son de otros titulares.`,
        );
      }
      if (col("titular", f.campos) === "") {
        return error(f.numero, `La unidad ${etiqueta} está dos veces en la planilla (filas ${primera.numero} y ${f.numero}).`);
      }
    }

    const superficieTexto = col("superficie_m2", primera.campos);
    const superficie = superficieTexto === "" ? null : leerNumeroDePlanilla(superficieTexto);
    if (superficieTexto !== "" && (superficie === null || superficie === "0.00")) {
      return error(primera.numero, `La superficie «${superficieTexto}» no es válida: un número mayor que cero, con hasta 2 decimales.`);
    }
    const estado = leerEstado(col("estado", primera.campos));
    if (estado === "invalido") return error(primera.numero, `El estado «${col("estado", primera.campos)}» no es válido: Baldío, En construcción o Construida.`);
    const nomenclatura = col("nomenclatura", primera.campos) || null;
    if (nomenclatura && nomenclatura.length > 60) return error(primera.numero, "La nomenclatura tiene hasta 60 caracteres.");

    const cbuTexto = col("cbu_unidad", primera.campos);
    const aliasTexto = col("alias_unidad", primera.campos);
    if (!opciones.cuentaPorUnidad && (cbuTexto !== "" || aliasTexto !== "")) {
      return error(primera.numero, "Este barrio cobra con una cuenta para todo el barrio: la planilla no lleva cbu_unidad ni alias_unidad.");
    }
    const cbu = cbuTexto === "" ? null : normalizarCbu(cbuTexto);
    if (cbuTexto !== "" && cbu === null) return error(primera.numero, `El CBU ${cbuTexto} no es válido: tiene que tener 22 dígitos y los verificadores bien.`);
    const alias = aliasTexto === "" ? null : normalizarAlias(aliasTexto);
    if (aliasTexto !== "" && alias === null) return error(primera.numero, `El alias «${aliasTexto}» no es válido: de 6 a 20 letras, números, puntos o guiones.`);

    const saldoTexto = col("saldo_inicial", primera.campos);
    const saldoInicial = saldoTexto === "" ? null : leerNumeroDePlanilla(saldoTexto);
    if (saldoTexto !== "" && saldoInicial === null) {
      return error(primera.numero, `El saldo inicial «${saldoTexto}» no es válido: un importe sin signo, con hasta 2 decimales.`);
    }

    const numeroAccion = col("numero_accion", primera.campos) || null;
    if (numeroAccion && numeroAccion.length > 30) return error(primera.numero, "El número de acción tiene hasta 30 caracteres.");
    const residenteNombre = col("residente", primera.campos);
    const residenteCaracterTexto = col("residente_caracter", primera.campos);
    const residenteTelefono = col("residente_telefono", primera.campos);
    const residenteMail = col("residente_mail", primera.campos);
    let residente: ResidenteDeUnidad | null = null;
    if (residenteNombre === "") {
      if (residenteCaracterTexto !== "" || residenteTelefono !== "" || residenteMail !== "") {
        return error(primera.numero, "Hay carácter, teléfono o mail del residente sin su nombre.");
      }
    } else {
      if (residenteNombre.length > 200) return error(primera.numero, "El nombre del residente tiene hasta 200 caracteres.");
      const caracter = leerCaracterResidente(residenteCaracterTexto);
      if (caracter === "invalido") {
        return error(primera.numero, `El carácter del residente «${residenteCaracterTexto}» no es válido: Inquilino, Residente u Otro.`);
      }
      if (residenteMail !== "" && (residenteMail.length > 120 || !MAIL.test(residenteMail))) {
        return error(primera.numero, `El mail del residente ${residenteMail} no tiene la forma nombre@dominio.`);
      }
      if (residenteTelefono !== "" && !TELEFONO.test(residenteTelefono)) {
        return error(primera.numero, "El teléfono del residente va con números, espacios, guiones o paréntesis.");
      }
      residente = {
        nombre: residenteNombre,
        caracter,
        telefono: residenteTelefono === "" ? null : residenteTelefono,
        mail: residenteMail === "" ? null : residenteMail.toLowerCase(),
      };
    }

    const titulares: TitularLeido[] = [];
    for (const f of g.filas) {
      const nombre = col("titular", f.campos);
      const docTexto = col("cuit_o_dni", f.campos);
      const mail = col("mail", f.campos);
      const telefono = col("telefono", f.campos);
      if (nombre === "") {
        if (docTexto !== "" || mail !== "" || telefono !== "" || leerSiNo(col("recibe_boleta", f.campos))) {
          return error(f.numero, "Hay CUIT, mail, teléfono o «recibe_boleta» sin el nombre del titular.");
        }
        continue;
      }
      if (nombre.length > 200) return error(f.numero, "El nombre del titular tiene hasta 200 caracteres.");
      const documento = leerDocumento(docTexto);
      if (documento === "invalido") {
        return error(f.numero, `El CUIT o DNI ${docTexto} no es válido: revisá el dígito verificador (CUIT de 11 dígitos, DNI de 7 u 8).`);
      }
      const caracter = leerCaracter(col("caracter", f.campos));
      if (caracter === "invalido") {
        return error(f.numero, `El carácter «${col("caracter", f.campos)}» no es válido: Propietario, Poseedor, Usufructuario o Tenedor.`);
      }
      if (mail !== "" && (mail.length > 120 || !MAIL.test(mail))) return error(f.numero, `El mail ${mail} no tiene la forma nombre@dominio.`);
      if (telefono !== "" && !TELEFONO.test(telefono)) return error(f.numero, "El teléfono va con números, espacios, guiones o paréntesis.");
      titulares.push({
        fila: f.numero,
        nombre,
        caracter,
        documento,
        recibeBoleta: leerSiNo(col("recibe_boleta", f.campos)),
        mail: mail === "" ? null : mail.toLowerCase(),
        telefono: telefono === "" ? null : telefono,
      });
    }

    const marcados = titulares.filter((t) => t.recibeBoleta);
    if (marcados.length > 1) {
      return error(marcados[1]!.fila, `La unidad ${etiqueta} tiene ${marcados.length} marcas en recibe_boleta: una sola persona recibe la boleta.`);
    }
    if (marcados.length === 0 && titulares.length > 1) {
      return error(primera.numero, `La unidad ${etiqueta} tiene ${titulares.length} titulares y ninguno marcado en recibe_boleta: marcá quién la recibe.`);
    }
    const docs = new Set<string>();
    for (const t of titulares) {
      if (!t.documento) continue;
      const k = `${t.documento.tipo}:${t.documento.numero}`;
      if (docs.has(k)) return error(t.fila, `${documentoLegible(t.documento)} está dos veces en la unidad ${etiqueta}.`);
      docs.add(k);
    }

    return {
      ok: true,
      fila: primera.numero,
      filas,
      manzana,
      lote,
      etiqueta: etiqueta!,
      superficie,
      estado,
      nomenclatura,
      cbu,
      alias,
      saldoInicial,
      numeroAccion,
      residente,
      // Con un solo titular, recibe la boleta aunque no esté marcado.
      titulares: titulares.length === 1 ? [{ ...titulares[0]!, recibeBoleta: true }] : titulares,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El plan
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Una persona del barrio (un `obligado`). */
export type PersonaRegistrada = {
  readonly obligadoId: string;
  readonly nombre: string;
  readonly documento: Documento;
  /** Las unidades donde es titular vigente, para decirlo en el «a revisar». */
  readonly unidades: readonly string[];
};

export type TitularExistente = {
  readonly obligadoId: string;
  readonly nombre: string;
  readonly documento: Documento | null;
  readonly email: string | null;
  readonly telefono: string | null;
};

export type UnidadExistente = {
  readonly id: string;
  readonly manzana: string;
  readonly lote: string;
  readonly dadaDeBaja: boolean;
  readonly superficie: string | null;
  readonly estado: EstadoUnidad;
  readonly nomenclatura: string | null;
  readonly cbu: string | null;
  readonly alias: string | null;
  readonly saldoInicial: string;
  /** `false` si una boleta emitida ya imprimió el saldo inicial: no se cambia más. */
  readonly saldoInicialEditable: boolean;
  readonly numeroAccion: string | null;
  readonly residente: ResidenteDeUnidad | null;
  readonly titulares: readonly TitularExistente[];
};

export type DecisionPersona = "misma" | "otra";

export type AccionPadron = "alta" | "corrige" | "sin_cambios";

export type TitularDelPlan = TitularLeido & {
  /** La persona ya registrada que se usa (misma documento y nombre, o decidido «es la misma»). */
  readonly obligadoId: string | null;
};

export type ARevisar = {
  readonly fila: number;
  readonly documento: string;
  readonly registrado: string;
  readonly unidadesDelRegistrado: readonly string[];
  readonly enPlanilla: string;
  readonly decision: DecisionPersona | null;
};

export type PlanDeUnidad = {
  readonly fila: number;
  readonly filas: readonly number[];
  readonly etiqueta: string | null;
  readonly accion: AccionPadron | null;
  readonly error: string | null;
  /** Qué cambia, en castellano: «Superficie 620,00 → 640,00 m²». */
  readonly detalle: readonly string[];
  readonly aRevisar: readonly ARevisar[];
  readonly unidad: UnidadLeida | null;
  readonly existenteId: string | null;
  readonly titulares: readonly TitularDelPlan[];
};

export type PlanDePadron = {
  readonly unidades: readonly PlanDeUnidad[];
  readonly ok: boolean;
  readonly altas: number;
  readonly correcciones: number;
  readonly sinCambios: number;
  readonly aRevisar: number;
  readonly conError: number;
  readonly filas: number;
};

const claveDoc = (d: Documento) => `${d.tipo}:${d.numero}`;

/** «620.00» → «620,00». Sin `Intl`: la regla 6 del repo lo prohíbe. */
function decimalLegible(v: string): string {
  const [e = "0", d = "00"] = v.split(".");
  return `${e.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
}

const ESTADO_LEGIBLE: Record<EstadoUnidad, string> = { baldio: "Baldío", en_construccion: "En construcción", construido: "Construida" };

/**
 * Decide qué hace cada unidad contra lo que ya hay en el barrio. `decisiones`: por número de fila del
 * titular «a revisar».
 */
export function planDePadron(
  lectura: readonly LecturaDeUnidad[],
  existentes: readonly UnidadExistente[],
  registradas: readonly PersonaRegistrada[],
  decisiones: ReadonlyMap<number, DecisionPersona> = new Map(),
): PlanDePadron {
  const porClave = new Map(existentes.map((u) => [clave(u.manzana, u.lote), u]));
  const registradaPorDoc = new Map(registradas.map((r) => [claveDoc(r.documento), r]));

  // El mismo documento con dos nombres dentro de la planilla: error en las filas de ese documento.
  const nombrePorDoc = new Map<string, { nombre: string; fila: number }>();
  const docConDosNombres = new Map<string, number>();
  for (const u of lectura) {
    if (!u.ok) continue;
    for (const t of u.titulares) {
      if (!t.documento) continue;
      const k = claveDoc(t.documento);
      const previo = nombrePorDoc.get(k);
      if (!previo) nombrePorDoc.set(k, { nombre: t.nombre, fila: t.fila });
      else if (!nombresIguales(previo.nombre, t.nombre)) docConDosNombres.set(`${k}@${t.fila}`, previo.fila);
    }
  }
  // Una cuenta repetida dentro de la planilla.
  const cuentas = new Map<string, number>();
  // El número de acción: único en el barrio (`uq_uf_barrio_numero_accion`), sin mayúsculas ni espacios.
  const claveAccion = (n: string) => n.trim().toUpperCase();
  const accionDeExistente = new Map(
    existentes.flatMap((u) => (u.numeroAccion ? [[claveAccion(u.numeroAccion), u] as const] : [])),
  );
  const accionesEnPlanilla = new Map<string, number>();

  const plan = lectura.map((u): PlanDeUnidad => {
    const base = { fila: u.fila, filas: u.filas, etiqueta: u.etiqueta, detalle: [], aRevisar: [], unidad: null, existenteId: null, titulares: [] };
    if (!u.ok) return { ...base, accion: null, error: u.error };
    const conError = (mensaje: string): PlanDeUnidad => ({ ...base, unidad: u, accion: null, error: mensaje });

    for (const [k, etiqueta] of [
      [u.cbu, "El CBU"],
      [u.alias?.toLowerCase() ?? null, "El alias"],
    ] as const) {
      if (!k) continue;
      const previo = cuentas.get(k);
      if (previo !== undefined) return conError(`${etiqueta} de la unidad ${u.etiqueta} ya está en la fila ${previo}: cada unidad tiene su propia cuenta.`);
      cuentas.set(k, u.fila);
    }
    if (u.numeroAccion) {
      const k = claveAccion(u.numeroAccion);
      const previo = accionesEnPlanilla.get(k);
      if (previo !== undefined) return conError(`El número de acción ${u.numeroAccion} ya está en la fila ${previo}: es único en el barrio.`);
      accionesEnPlanilla.set(k, u.fila);
      const duena = accionDeExistente.get(k);
      if (duena && clave(duena.manzana, duena.lote) !== clave(u.manzana, u.lote)) {
        return conError(
          `El número de acción ${u.numeroAccion} ya es de ${etiquetaUnidad(duena.manzana, duena.lote)}: es único en el barrio. Para pasárselo a esta unidad, primero sacáselo a la otra desde su ficha.`,
        );
      }
    }

    // Los titulares: ¿personas ya registradas?
    const aRevisar: ARevisar[] = [];
    const titulares: TitularDelPlan[] = [];
    for (const t of u.titulares) {
      if (t.documento) {
        const otraFila = docConDosNombres.get(`${claveDoc(t.documento)}@${t.fila}`);
        if (otraFila !== undefined) {
          return conError(`${documentoLegible(t.documento)} viene con otro nombre en la fila ${otraFila}.`);
        }
      }
      const registrada = t.documento ? registradaPorDoc.get(claveDoc(t.documento)) : undefined;
      if (!registrada) {
        titulares.push({ ...t, obligadoId: null });
        continue;
      }
      if (nombresIguales(registrada.nombre, t.nombre)) {
        titulares.push({ ...t, obligadoId: registrada.obligadoId });
        continue;
      }
      const decision = decisiones.get(t.fila) ?? null;
      if (decision === "otra") {
        return conError(
          `${documentoLegible(t.documento!)} ya es de ${registrada.nombre} en este barrio, y se decidió que ${t.nombre} es otra persona: corregí el documento en la planilla.`,
        );
      }
      aRevisar.push({
        fila: t.fila,
        documento: documentoLegible(t.documento!),
        registrado: registrada.nombre,
        unidadesDelRegistrado: registrada.unidades,
        enPlanilla: t.nombre,
        decision,
      });
      titulares.push({ ...t, obligadoId: decision === "misma" ? registrada.obligadoId : null });
    }

    const previa = porClave.get(clave(u.manzana, u.lote));
    if (!previa) {
      const detalle = [
        titulares.length === 0
          ? "Sin titular."
          : titulares.length === 1
            ? `Titular: ${titulares[0]!.nombre}.`
            : `${titulares.length} titulares: ${titulares.map((t) => t.nombre).join(" y ")}.`,
        ...(u.cbu || u.alias ? ["Con cuenta propia."] : []),
        ...(u.saldoInicial && u.saldoInicial !== "0.00" ? [`Saldo inicial $ ${decimalLegible(u.saldoInicial)}.`] : []),
        ...(u.numeroAccion ? [`Acción ${u.numeroAccion}.`] : []),
        ...(u.residente ? [`Residente: ${u.residente.nombre}.`] : []),
      ];
      return { ...base, unidad: u, accion: "alta", error: null, detalle, aRevisar, titulares };
    }

    if (previa.dadaDeBaja) return conError(`La unidad ${u.etiqueta} está dada de baja: no se corrige por planilla.`);

    // Corrige: los titulares de la planilla tienen que ser los que la unidad ya tiene.
    const detalle: string[] = [];
    for (const t of titulares) {
      const actual = previa.titulares.find((x) =>
        t.documento && x.documento ? claveDoc(x.documento) === claveDoc(t.documento) : nombresIguales(x.nombre, t.nombre),
      );
      if (!actual) {
        return conError(
          `${t.nombre} no es titular de ${u.etiqueta}: un cambio de titular no se hace por planilla (tiene fecha e historial). Usá «Cambiar titular» en la ficha.`,
        );
      }
      if (t.mail && t.mail !== (actual.email ?? "").toLowerCase()) detalle.push(`Mail de ${actual.nombre}: ${t.mail}.`);
      if (t.telefono && t.telefono !== actual.telefono) detalle.push(`Teléfono de ${actual.nombre}: ${t.telefono}.`);
    }
    if (u.superficie !== null && u.superficie !== previa.superficie) {
      detalle.unshift(`Superficie ${previa.superficie === null ? "—" : decimalLegible(previa.superficie)} → ${decimalLegible(u.superficie)} m².`);
    }
    if (u.estado !== null && u.estado !== previa.estado) detalle.push(`Estado ${ESTADO_LEGIBLE[previa.estado]} → ${ESTADO_LEGIBLE[u.estado]}.`);
    if (u.nomenclatura !== null && u.nomenclatura !== previa.nomenclatura) detalle.push(`Nomenclatura → ${u.nomenclatura}.`);
    if (u.cbu !== null && u.cbu !== previa.cbu) detalle.push(`CBU de la unidad → ${u.cbu}.`);
    if (u.alias !== null && u.alias.toLowerCase() !== (previa.alias ?? "").toLowerCase()) detalle.push(`Alias de la unidad → ${u.alias}.`);
    if (u.numeroAccion !== null && u.numeroAccion !== previa.numeroAccion) {
      detalle.push(`Número de acción ${previa.numeroAccion ?? "—"} → ${u.numeroAccion}.`);
    }
    if (
      u.residente !== null &&
      (u.residente.nombre !== previa.residente?.nombre ||
        (u.residente.caracter ?? null) !== (previa.residente?.caracter ?? null) ||
        (u.residente.telefono ?? null) !== (previa.residente?.telefono ?? null) ||
        (u.residente.mail ?? null) !== (previa.residente?.mail ?? null))
    ) {
      detalle.push(`Residente: ${u.residente.nombre}.`);
    }
    if (u.saldoInicial !== null && u.saldoInicial !== previa.saldoInicial) {
      if (!previa.saldoInicialEditable) {
        return conError(`El saldo inicial de ${u.etiqueta} ya se usó en una boleta emitida: no se cambia (se carga una sola vez).`);
      }
      detalle.push(`Saldo inicial $ ${decimalLegible(previa.saldoInicial)} → $ ${decimalLegible(u.saldoInicial)}.`);
    }
    if (detalle.length > 0 && titulares.length > 0) detalle.push("El titular no cambia.");
    return {
      ...base,
      unidad: u,
      existenteId: previa.id,
      accion: detalle.length === 0 ? "sin_cambios" : "corrige",
      error: null,
      detalle: detalle.length === 0 ? ["Sin cambios."] : detalle,
      aRevisar,
      titulares,
    };
  });

  const pendientes = plan.reduce((n, p) => n + p.aRevisar.filter((r) => r.decision === null).length, 0);
  return {
    unidades: plan,
    ok: plan.every((p) => p.error === null) && pendientes === 0,
    altas: plan.filter((p) => p.accion === "alta").length,
    correcciones: plan.filter((p) => p.accion === "corrige").length,
    sinCambios: plan.filter((p) => p.accion === "sin_cambios").length,
    aRevisar: pendientes,
    conError: plan.filter((p) => p.error !== null).length,
    filas: plan.reduce((n, p) => n + p.filas.length, 0),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Exportar y plantilla
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type UnidadParaExportar = Omit<UnidadExistente, "id" | "dadaDeBaja" | "saldoInicialEditable" | "titulares"> & {
  readonly titulares: readonly (TitularExistente & { readonly caracter: TipoObligado; readonly recibeBoleta: boolean })[];
};

const CARACTER_RESIDENTE_LEGIBLE: Record<CaracterResidente, string> = { inquilino: "Inquilino", residente: "Residente", otro: "Otro" };

const CARACTER_LEGIBLE: Record<TipoObligado, string> = {
  propietario: "Propietario",
  poseedor: "Poseedor",
  usufructuario: "Usufructuario",
  tenedor: "Tenedor",
};

/**
 * Las filas de la planilla del padrón (encabezado incluido), con las mismas columnas que se importan:
 * se baja, se corrige y se vuelve a subir. Una fila por titular; los datos de la unidad en la primera.
 * Los números van con coma decimal, como los escribe Excel en castellano.
 */
export function filasParaExportar(unidades: readonly UnidadParaExportar[], cuentaPorUnidad: boolean): string[][] {
  const columnas = columnasDelPadron(cuentaPorUnidad);
  const filas: string[][] = [[...columnas]];
  for (const u of unidades) {
    const titulares = u.titulares.length > 0 ? u.titulares : [null];
    titulares.forEach((t, i) => {
      const primera = i === 0;
      const valores: Record<ColumnaPadron, string> = {
        manzana: u.manzana,
        lote: u.lote,
        superficie_m2: primera && u.superficie !== null ? u.superficie.replace(".", ",") : "",
        estado: primera ? ESTADO_LEGIBLE[u.estado] : "",
        nomenclatura: primera ? (u.nomenclatura ?? "") : "",
        titular: t?.nombre ?? "",
        caracter: t ? CARACTER_LEGIBLE[t.caracter] : "",
        cuit_o_dni: t?.documento ? t.documento.numero : "",
        recibe_boleta: t?.recibeBoleta ? "sí" : "",
        mail: t?.email ?? "",
        telefono: t?.telefono ?? "",
        cbu_unidad: primera ? (u.cbu ?? "") : "",
        alias_unidad: primera ? (u.alias ?? "") : "",
        saldo_inicial: primera && u.saldoInicial !== "0.00" ? u.saldoInicial.replace(".", ",") : "",
        numero_accion: primera ? (u.numeroAccion ?? "") : "",
        residente: primera ? (u.residente?.nombre ?? "") : "",
        residente_caracter: primera && u.residente?.caracter ? CARACTER_RESIDENTE_LEGIBLE[u.residente.caracter] : "",
        residente_telefono: primera ? (u.residente?.telefono ?? "") : "",
        residente_mail: primera ? (u.residente?.mail ?? "") : "",
      };
      filas.push(columnas.map((c) => valores[c]));
    });
  }
  return filas;
}

/** La plantilla que se baja desde la pantalla: el encabezado y una fila de ejemplo inventada. */
export function filasDePlantilla(cuentaPorUnidad: boolean): string[][] {
  const columnas = columnasDelPadron(cuentaPorUnidad);
  const ejemplo: Record<ColumnaPadron, string> = {
    manzana: "1",
    lote: "1",
    superficie_m2: "600,00",
    estado: "Construida",
    nomenclatura: "",
    titular: "Ana Ejemplo",
    caracter: "Propietario",
    cuit_o_dni: "20111111112",
    recibe_boleta: "sí",
    mail: "ana.ejemplo@correo.example",
    telefono: "351 555-0101",
    cbu_unidad: "",
    alias_unidad: "",
    saldo_inicial: "",
    numero_accion: "101",
    residente: "",
    residente_caracter: "",
    residente_telefono: "",
    residente_mail: "",
  };
  return [[...columnas], columnas.map((c) => ejemplo[c])];
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Planilla de coeficientes (pantalla 6, «Cargar por planilla»)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type CoeficienteLeido = { readonly fila: number; readonly manzana: string; readonly lote: string; readonly peso: string };

/** `manzana · lote · coeficiente`. Devuelve las filas leídas o la lista de errores por fila. */
export function leerPlanillaCoeficientes(
  filasCrudas: readonly (readonly string[])[],
): { readonly ok: true; readonly filas: readonly CoeficienteLeido[] } | { readonly ok: false; readonly errores: readonly string[] } {
  const [encabezado, ...resto] = filasCrudas;
  const nombres = (encabezado ?? []).map((c) => sinAcentos(c));
  const im = nombres.indexOf("manzana");
  const il = nombres.indexOf("lote");
  const ic = nombres.indexOf("coeficiente");
  if (im < 0 || il < 0 || ic < 0) return { ok: false, errores: ["La planilla necesita las columnas manzana, lote y coeficiente."] };
  const errores: string[] = [];
  const filas: CoeficienteLeido[] = [];
  const vistas = new Set<string>();
  resto.forEach((c, i) => {
    if (!c.some((x) => x.trim() !== "")) return;
    const fila = i + 2;
    const manzana = (c[im] ?? "").trim();
    const lote = (c[il] ?? "").trim();
    const peso = leerNumeroDePlanilla(c[ic] ?? "", 9);
    if (!manzana || !lote) errores.push(`Fila ${fila}: falta la manzana o el lote.`);
    else if (peso === null || /^0\.0+$/.test(peso)) errores.push(`Fila ${fila}: el coeficiente tiene que ser un número mayor que cero (hasta 9 decimales).`);
    else if (vistas.has(clave(manzana, lote))) errores.push(`Fila ${fila}: la unidad ${etiquetaUnidad(manzana, lote)} está dos veces.`);
    else {
      vistas.add(clave(manzana, lote));
      filas.push({ fila, manzana, lote, peso });
    }
  });
  if (filas.length === 0 && errores.length === 0) errores.push("La planilla no tiene filas.");
  return errores.length > 0 ? { ok: false, errores } : { ok: true, filas };
}
