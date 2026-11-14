/**
 * Modo demo (BL-004): una administración inventada con **cuatro barrios a escala real** —unas 2.000
 * unidades— para mostrarle el sistema a un estudio administrador como lo que es: un producto, no la
 * solución de un barrio.
 *
 * | Barrio          | Figura            | Modelo      | UF  | Medio de cobro    | Lo que muestra                         |
 * |-----------------|-------------------|-------------|-----|-------------------|----------------------------------------|
 * | Los Aromos      | Asociación civil  | coeficiente | 460 | genérico de demo  | tasa propia; un período en borrador    |
 * | Las Cortaderas  | Asociación civil  | coeficiente | 340 | transferencia-QR  | «No se cobra» interés                  |
 * | Los Talas       | S.A.              | cuota fija  | 700 | transferencia-QR  | el paginado (> 500) y la evolución     |
 * | El Algarrobal   | S.A.              | cuota fija  | 500 | genérico de demo  | la general programada lo alcanza       |
 * | Los Ceibos      | S.A.              | cuota fija  |  40 | transferencia-QR  | recién creado (T3): cuenta por unidad  |
 *
 * **Los Ceibos** se crea al final y por el mismo camino que la pantalla (alta de barrio, importación
 * de la planilla, cuota): una cuenta por unidad —algunas unidades sin cuenta propia—, Mza 1 · Lote 4
 * con dos titulares, dos unidades con saldo inicial, y su primer período (el mes en curso) emitido.
 * La planilla de ejemplo para importar EN VIVO en la demo está en `docs/demo/padron-de-ejemplo.csv`.
 *
 * **Proveedores, órdenes de pago y cobros para recorrer cada pantalla** (encargo 9, PR 1 §1), en Los
 * Aromos y Las Cortaderas: un catálogo de 7 proveedores (uno inactivo), órdenes de pago en todos los
 * estados —dos pendientes, una aprobada con su gasto en el borrador, una pagada, una rechazada con
 * motivo y una anulada de un mes emitido con su ajuste en el borrador (P2)—, el mes en curso en
 * borrador con gastos a mano y de órdenes, un pago anulado, un cargo vigente y uno anulado, y en Los
 * Aromos un pago tardío imputado con «No cobrar interés». Todo por los servicios de la aplicación,
 * sin saltear ningún trigger: el mismo camino que la pantalla.
 *
 * Cada barrio tiene **el mes anterior emitido y cobrado** —la mayoría en término, algunos fuera de
 * término, algunos impagos— y **el mes actual emitido**, con el saldo de los impagos arrastrado desde
 * la cuenta corriente y su interés por mora calculado: la revisión y la boleta muestran interés
 * distinto de $ 0 y el tablero muestra deuda vencida.
 *
 * **Todo es inventado y determinístico**: nombres, documentos y correos salen de un generador con
 * semilla fija (`SEMILLA`), y manzanas y lotes se generan por código. Ningún dato ni geometría del
 * barrio piloto (ADR-0001 §1; CLAUDE.md §1.6). Las fechas son relativas al mes en curso, que es lo que
 * hace que la demo siempre muestre "el mes actual".
 *
 * Idempotente: borra la administración demo anterior (por id fijo) y la vuelve a crear.
 *
 * Uso: `pnpm db:seed` (después de `pnpm db:migrate && pnpm db:setup`).
 */
import pg from "pg";
import { sql } from "drizzle-orm";
import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";
import { aCentavos, deCentavos, prorratear } from "@admin-barrios/shared/dinero";
import { sugerirDenominacionConcepto, type FiguraJuridica } from "@admin-barrios/shared/barrio";
import { conUsuario, crearDbMantenimiento, type DbConIdentidad } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { condonarInteres, imputarPagoConInteres, registrarEImputarPago, vistaPreviaDelPago } from "../src/servicios/deuda.ts";
import { anularAplicacion, aplicarConceptoAUnidad } from "../src/servicios/cargos.ts";
import { anularPago } from "../src/servicios/pagos.ts";
import { desactivarProveedor, registrarProveedor } from "../src/servicios/proveedores.ts";
import {
  anularOrdenPago,
  aprobarOrdenPago,
  marcarOrdenPagada,
  rechazarOrdenPago,
  registrarOrdenPago,
} from "../src/servicios/ordenes-pago.ts";
import { verificadorBloque1, verificadorBloque2 } from "@admin-barrios/shared/cuentas";
import { armarDescripcion } from "../src/servicios/usuarios-demo.ts";
import { confirmarImportacion, crearBarrio as crearBarrioPadron } from "../src/servicios/padron-edicion.ts";
import { definirCuotaFija } from "../src/servicios/cuota-fija.ts";
import { columnasDelPadron, type ColumnaPadron } from "@admin-barrios/shared/padron";
import type { CondicionFiscal } from "@admin-barrios/shared/escrituras";
import { aliasDeDemostracion, cuentaDeDemostracion } from "@admin-barrios/documentos/cobranza";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Falta DATABASE_URL (ver .env.example)");
exigirEntornoLocal("el seed de demo");

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Identidad fija de la demo
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ADMINISTRADOR = "Estudio Demo — Administración";

/**
 * El id del administrador demo es **fijo**, como los del elenco: la limpieza no depende de ningún
 * texto. El 2026-08-04 una búsqueda por nombre dejó de encontrar el demo anterior (se habían reparado
 * los acentos del nombre) y `pnpm db:seed` sembró un juego entero encima del otro.
 */
const ADMINISTRADOR_ID = "00000000-0000-4000-9000-000000000001";

/** La semilla del generador. Cambiarla cambia todas las personas, superficies y cobros de la demo. */
const SEMILLA = 20261102;

/** `mulberry32`: un generador chico, rápido y reproducible. Mismo número de entrada, misma demo. */
function generador(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const azar = generador(SEMILLA);
const entero = (min: number, max: number): number => min + Math.floor(azar() * (max - min + 1));
const elegir = <T>(lista: readonly T[]): T => lista[Math.floor(azar() * lista.length)] as T;

const NOMBRES = [
  "Ana", "Bruno", "Carla", "Diego", "Elena", "Franco", "Gabriela", "Hugo", "Irene", "Julián",
  "Karina", "Lucas", "Marta", "Nicolás", "Olivia", "Pablo", "Rocío", "Santiago", "Tamara", "Valentín",
  "Agustina", "Benjamín", "Camila", "Damián", "Emilia", "Facundo", "Guadalupe", "Ignacio", "Josefina", "Lautaro",
  "Martina", "Matías", "Natalia", "Octavio", "Paula", "Ramiro", "Sofía", "Tomás", "Victoria", "Joaquín",
] as const;
const APELLIDOS = [
  "Gómez", "Fernández", "López", "Martínez", "Sosa", "Ramírez", "Quiroga", "Ferreyra", "Peralta", "Bustos",
  "Acosta", "Benítez", "Cabrera", "Domínguez", "Escobar", "Funes", "Giménez", "Herrera", "Ibarra", "Juárez",
  "Ledesma", "Molina", "Navarro", "Ortiz", "Paz", "Ríos", "Suárez", "Torres", "Vega", "Zárate",
  "Aguirre", "Bravo", "Castro", "Díaz", "Figueroa", "Godoy", "Luna", "Moyano", "Olmedo", "Villalba",
] as const;

/** Sin acentos ni espacios, para armar un correo inventado. */
const sinAcentos = (texto: string): string =>
  texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Un arreglo como literal de Postgres (`{a,b,c}`), para pasarlo como UN parámetro a través de
 * Drizzle, que expande un arreglo de JS en una lista de parámetros. Solo para uuids y fechas ISO,
 * que no llevan comas, llaves ni comillas.
 */
const arregloPg = (valores: readonly string[]): string => {
  if (valores.some((v) => !/^[0-9a-f-]+$/i.test(v))) throw new Error("arregloPg: solo uuids o fechas ISO");
  return `{${valores.join(",")}}`;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fechas: relativas al mes en curso, en texto `YYYY-MM-DD` (sin zona horaria: son días de calendario)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// En UTC, como `current_date` de la base en Docker: si el script usara la hora local, entre las 21 y
// las 24 del último día del mes "el mes en curso" del seed y el de la base serían distintos.
const hoy = new Date();
/** `YYYY-MM` de hace `n` meses (`0` = el mes en curso, negativo = meses que vienen). */
const mesAtras = (n: number): string => {
  const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - n, 1));
  return d.toISOString().slice(0, 7);
};
/** El mes siguiente a `YYYY-MM`. */
const mesSiguiente = (periodo: string): string => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
};
const sumarDias = (iso: string, dias: number): string => {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
};
const diasEntre = (desde: string, hasta: string): number =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
const hoyIso = hoy.toISOString().slice(0, 10);
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;
/** `2026-11` → «noviembre de 2026», para las descripciones de las órdenes de pago. */
const formatearMes = (periodo: string): string => {
  const [a, m] = periodo.split("-") as [string, string];
  return `${MESES[Number(m) - 1]} de ${a}`;
};
const MES_EN_CURSO = mesAtras(0);

/**
 * Cuándo vence un período, según el modelo. **No es una preferencia: sale del modelo.** En cuota fija
 * el importe está decidido de antemano y el mes se cobra dentro de sí mismo (vence el 10, segunda
 * fecha el 13). Al prorratear no se sabe cuánto paga cada unidad hasta que el mes cerró y llegaron
 * las facturas, así que vence el mes siguiente (10 y 20). Dos fechas configurables es el concepto; que
 * un barrio no cobre recargo en la segunda es política suya.
 */
const vencimientos = (modelo: "coeficiente" | "fija", periodo: string): { primero: string; segundo: string } => {
  const mes = modelo === "fija" ? periodo : mesSiguiente(periodo);
  const entreFechas = modelo === "fija" ? 3 : 10;
  const primero = `${mes}-10`;
  // El mes actual tiene que estar **sin vencer** el día que se siembra, o el tablero mostraría como
  // deuda vencida la boleta que nadie pagó todavía porque se emitió recién (revisión de código): si
  // el 10 ya está a menos de una semana, vence a la semana de hoy. Los meses anteriores no se tocan.
  const limite = sumarDias(hoyIso, 7);
  const efectivo = mes === MES_EN_CURSO && primero < limite ? limite : primero;
  return { primero: efectivo, segundo: sumarDias(efectivo, entreFechas) };
};
/** El día en que se emitió: el 1° del mes en que vence. Es la fecha que el estado de cuenta usa para el débito. */
const diaDeEmision = (modelo: "coeficiente" | "fija", periodo: string): string =>
  `${(modelo === "fija" ? periodo : mesSiguiente(periodo))}-01`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Los cuatro barrios
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Gasto = readonly [nombre: string, monto: string, tipo: "ordinaria" | "extraordinaria", fondo?: boolean];

type DefinicionBarrio = {
  readonly clave: "aromos" | "cortaderas" | "talas" | "algarrobal";
  readonly nombre: string;
  readonly figura: FiguraJuridica;
  readonly modelo: "coeficiente" | "fija";
  readonly unidades: number;
  readonly medio: "generico-demo" | "transferencia-qr";
  readonly municipio: string;
  readonly domicilio: string;
  /** Manzanas con número o con letra: hay barrios de las dos formas. */
  readonly manzanas: "numeros" | "letras";
  /** Prefijo inventado de la nomenclatura catastral. */
  readonly catastro: string;
  /** Lo que ese barrio llama a lo que cobra. Lo elige el administrador; el sugeridor propone. */
  readonly denominacion: string;
  readonly gastos: readonly Gasto[];
  /** Solo cuota fija: la cuota vigente y las de los meses anteriores (del más viejo al más nuevo). */
  readonly cuota?: { readonly vigente: string; readonly anteriores: readonly string[] };
  /**
   * Los vencimientos configurados del barrio (encargo 15, `0078`): días del primero al segundo y días
   * de corte desde el último. Sin esto, el barrio no los usa (los otros tres de la demo).
   */
  readonly configuracionVencimientos?: { readonly dia: number; readonly diasSegundo: number; readonly diasCorte: number };
  /** Una de cada `cada` unidades con número de acción, y una de cada `residenteCada` con residente (inventados). */
  readonly datosDePadron?: { readonly prefijoAccion: string; readonly cada: number; readonly residenteCada: number };
};

/** Los gastos de un barrio de cuota fija de unos 500 lotes, con su orden de magnitud real. Sin proveedores. */
const GASTOS_LOTEO: readonly Gasto[] = [
  ["Seguridad privada", "91206999.58", "ordinaria"],
  ["Mantenimiento y jardinería de áreas verdes", "20482434.19", "ordinaria"],
  ["Recolección de residuos urbanos", "11492737.26", "ordinaria"],
  ["Adicional de policía (20 a 08 h)", "7833351.72", "ordinaria"],
  ["Personal de mantenimiento", "6699584.90", "ordinaria"],
  ["Energía eléctrica de espacios comunes", "5001441.80", "ordinaria"],
  ["Honorarios de intendencia", "3540000.00", "ordinaria"],
  ["Honorarios de administración", "3125000.00", "ordinaria"],
  ["Comisiones de medios de pago", "2865957.73", "ordinaria"],
  ["Impuesto Ley 25.413", "2020202.10", "ordinaria"],
  ["Cámaras: service mensual y reparaciones", "1950000.00", "ordinaria"],
  ["Honorarios legales", "1580687.16", "ordinaria"],
];

/** Un monto escalado por `porcentaje` (entero), en centavos exactos. */
const escalar = (monto: string, porcentaje: number): string =>
  deCentavos((aCentavos(monto) * BigInt(porcentaje)) / 100n);

const BARRIOS: readonly DefinicionBarrio[] = [
  {
    clave: "aromos",
    nombre: "Barrio Demo Los Aromos",
    figura: "asociacion_civil",
    modelo: "coeficiente",
    unidades: 460,
    medio: "generico-demo",
    municipio: "villa-allende",
    domicilio: "Camino de las Sierras km 3, Villa Allende, Córdoba",
    manzanas: "numeros",
    catastro: "13-01-45",
    denominacion: sugerirDenominacionConcepto("asociacion_civil")?.denominacion ?? "cuota social",
    gastos: [
      ["Seguridad y vigilancia", "52480000.00", "ordinaria"],
      ["Mantenimiento de espacios verdes", "14260500.00", "ordinaria"],
      ["Recolección de residuos", "7535000.00", "ordinaria"],
      ["Personal de mantenimiento", "6010000.00", "ordinaria"],
      ["Energía eléctrica de espacios comunes", "3840000.00", "ordinaria"],
      ["Honorarios de administración", "3105000.00", "ordinaria"],
      ["Fondo de reserva", "4000000.00", "ordinaria", true],
    ],
  },
  {
    clave: "cortaderas",
    nombre: "Barrio Demo Las Cortaderas",
    figura: "asociacion_civil",
    modelo: "coeficiente",
    unidades: 340,
    medio: "transferencia-qr",
    municipio: "mendiolaza",
    domicilio: "Camino a El Talar km 4, Mendiolaza, Córdoba",
    manzanas: "letras",
    catastro: "14-02-10",
    denominacion: "cuota social",
    gastos: [
      ["Seguridad y vigilancia", "38150000.00", "ordinaria"],
      ["Mantenimiento de espacios verdes", "9020000.00", "ordinaria"],
      ["Recolección de residuos", "5610000.00", "ordinaria"],
      ["Energía eléctrica de espacios comunes", "2930000.00", "ordinaria"],
      ["Honorarios de administración", "2410000.00", "ordinaria"],
      ["Mantenimiento del club house", "3120000.00", "ordinaria"],
    ],
  },
  {
    clave: "talas",
    nombre: "Barrio Demo Los Talas",
    figura: "sa",
    modelo: "fija",
    unidades: 700,
    medio: "transferencia-qr",
    municipio: "saldan",
    domicilio: "Ruta U-111 km 7, Saldán, Córdoba",
    manzanas: "numeros",
    catastro: "13-03-22",
    // "expensa" y no lo que sugiere la figura ("cuota social"): la denominación la elige el
    // administrador al dar de alta el barrio, y la demo muestra las dos.
    denominacion: "expensa",
    gastos: GASTOS_LOTEO.map(([n, m, t]) => [n, escalar(m, 137), t] as const),
    // Sube con dos mesetas y dos saltos, como ajusta un directorio de verdad: la tira de "cómo cambió
    // tu expensa" de la boleta necesita más de un período emitido para dibujarse.
    cuota: { vigente: "382000.00", anteriores: ["340000.00", "340000.00", "360500.00", "360500.00"] },
    // El segundo vencimiento a 3 días (el mismo importe) y el corte a 10 días del último: la boleta
    // imprime «Se puede pagar hasta el…». Una S.A.: sus unidades tienen número de acción.
    configuracionVencimientos: { dia: 10, diasSegundo: 3, diasCorte: 10 },
    datosDePadron: { prefijoAccion: "LT", cada: 4, residenteCada: 9 },
  },
  {
    clave: "algarrobal",
    nombre: "Barrio Demo El Algarrobal",
    figura: "sa",
    modelo: "fija",
    unidades: 500,
    medio: "generico-demo",
    municipio: "rio-ceballos",
    domicilio: "Av. San Martín 4800, Río Ceballos, Córdoba",
    manzanas: "numeros",
    catastro: "13-04-08",
    denominacion: sugerirDenominacionConcepto("sa")?.denominacion ?? "cuota social",
    gastos: GASTOS_LOTEO.map(([n, m, t]) => [n, escalar(m, 95), t] as const),
    cuota: { vigente: "295000.00", anteriores: [] },
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// La traza: manzanas y lotes generados, nunca un plano real
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Manzanas de 10 a 33 lotes hasta llegar a `total`. Una de cada cuatro tiene huecos (lotes que se
 * unificaron con los años), así que la numeración no siempre es correlativa — como en un barrio real.
 */
function generarTraza(total: number, estilo: "numeros" | "letras"): Array<{ manzana: string; lote: string }> {
  const salida: Array<{ manzana: string; lote: string }> = [];
  let indice = 0;
  while (salida.length < total) {
    indice += 1;
    const manzana = estilo === "letras" ? String.fromCharCode(64 + indice) : String(indice);
    if (estilo === "letras" && indice > 26) throw new Error("demasiadas manzanas para nombrarlas con letras");
    const cantidad = entero(10, 33);
    const huecos = azar() < 0.25 ? new Set([entero(1, cantidad), entero(1, cantidad)]) : new Set<number>();
    for (let lote = 1; lote <= cantidad + huecos.size && salida.length < total; lote++) {
      if (huecos.has(lote)) continue;
      salida.push({ manzana, lote: String(lote) });
    }
  }
  return salida;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Elenco: con quién se entra a la demo
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Los roles de `app.rol_membership` con los que se puede entrar a la demo (ADR-0002 §3.5). */
type RolDemo = "admin_barrio" | "operador" | "contador" | "auditor";

/**
 * Rol → cómo se llama en la pantalla de entrada. Derivado y no escrito al lado del nombre: una tarjeta
 * que dijera OPERADOR mientras la base dice `contador` desmentiría delante del cliente el argumento
 * central de la demo ("mirá cómo el sistema aísla por rol"). El `satisfies` obliga a que todo rol nuevo
 * traiga su etiqueta.
 */
const ETIQUETA_DE_ROL = {
  admin_barrio: { f: "Administradora", m: "Administrador" },
  operador: { f: "Operadora", m: "Operador" },
  contador: { f: "Contadora", m: "Contador" },
  auditor: { f: "Auditora", m: "Auditor" },
} as const satisfies Record<RolDemo, { readonly f: string; readonly m: string }>;

const USUARIO_DEMO = "00000000-0000-4000-8000-000000000001";
const OPERADOR_DEMO = "00000000-0000-4000-8000-000000000002";
const CONTADOR_DEMO = "00000000-0000-4000-8000-000000000003";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Proveedores y órdenes de pago (encargo 9, PR 1 §1): Los Aromos y Las Cortaderas
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Los barrios donde se siembra el circuito de proveedores, órdenes de pago y cobros para recorrer. */
const CON_CIRCUITO = new Set<string>(["aromos", "cortaderas"]);

/** Conceptos de gasto que solo existen para imputarles órdenes de pago (no entran en `def.gastos`). */
const CONCEPTOS_DE_PROVEEDORES = ["Limpieza de espacios comunes", "Mantenimiento de pileta", "Honorarios contables"] as const;

/**
 * CUIT inventado **con su verificador bien** (`normalizarCuit` lo acepta): prefijo + 8 dígitos, y si el
 * verificador daría 10 (no existe), se prueba con el número siguiente.
 */
const cuitInventado = (prefijo: "20" | "27" | "30" | "33", cuerpo: number): string => {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (let n = cuerpo; ; n++) {
    const base = `${prefijo}${String(n).padStart(8, "0")}`;
    const r = 11 - (pesos.reduce((acc, peso, i) => acc + peso * Number(base[i]), 0) % 11);
    if (r === 10) continue;
    return `${base}${r === 11 ? 0 : r}`;
  }
};

/** CBU de prueba con los dos verificadores bien, de un banco «999» que no existe. */
const cbuDePrueba = (cuenta: number): string => {
  const bloque1 = "9990001";
  const bloque2 = String(cuenta).padStart(13, "0");
  return `${bloque1}${verificadorBloque1(bloque1)}${bloque2}${verificadorBloque2(bloque2)}`;
};

type ClaveProveedor = "limpieza" | "seguridad" | "jardineria" | "electricidad" | "pileta" | "contador" | "residuos";

/** El catálogo de cada barrio con circuito: los rubros típicos de un barrio cerrado. Todo inventado. */
const PROVEEDORES_DEMO: ReadonlyArray<{
  clave: ClaveProveedor;
  razonSocial: string;
  prefijo: "20" | "27" | "30" | "33";
  /** De la lista de `shared` (encargo 10, BL-030 g): el tipo no deja escribir otra cosa. */
  condicionFiscal: CondicionFiscal;
  contacto: string;
  alias: string | null;
  /** Concepto de gasto al que se le imputan sus órdenes. */
  concepto: string;
  /** El proveedor que se reemplazó: queda en el catálogo, desactivado. */
  inactivo?: true;
}> = [
  { clave: "limpieza", razonSocial: "Brillo Serrano Servicios de Limpieza S.R.L.", prefijo: "30", condicionFiscal: "Responsable Inscripto",
    contacto: "Lorena Bustos · 351 555-0101 · administracion@brilloserrano.test", alias: "BRILLO.SERRANO", concepto: "Limpieza de espacios comunes" },
  { clave: "seguridad", razonSocial: "Centinela Seguridad Privada S.A.", prefijo: "30", condicionFiscal: "Responsable Inscripto",
    contacto: "Mesa de operaciones · 351 555-0102 · facturacion@centinela.test", alias: "CENTINELA.SEG", concepto: "Seguridad y vigilancia" },
  { clave: "jardineria", razonSocial: "Verde Monte Parques y Jardines", prefijo: "20", condicionFiscal: "Monotributo",
    contacto: "Héctor Funes · 351 555-0103 · verdemonte@ejemplo.test", alias: null, concepto: "Mantenimiento de espacios verdes" },
  { clave: "electricidad", razonSocial: "Electro Sierras Instalaciones S.R.L.", prefijo: "30", condicionFiscal: "Responsable Inscripto",
    contacto: "Guardia técnica · 351 555-0104", alias: "ELECTRO.SIERRAS", concepto: "Energía eléctrica de espacios comunes" },
  { clave: "pileta", razonSocial: "Aguas Claras Mantenimiento de Piletas", prefijo: "27", condicionFiscal: "Monotributo",
    contacto: "Natalia Ríos · 351 555-0105 · aguasclaras@ejemplo.test", alias: null, concepto: "Mantenimiento de pileta" },
  { clave: "contador", razonSocial: "Estudio Contable Paz & Asociados", prefijo: "30", condicionFiscal: "Responsable Inscripto",
    contacto: "Cdora. Marta Paz · 351 555-0106 · estudio@pazasociados.test", alias: "ESTUDIO.PAZ", concepto: "Honorarios contables" },
  { clave: "residuos", razonSocial: "Recolectora del Valle S.A.", prefijo: "30", condicionFiscal: "Responsable Inscripto",
    contacto: "351 555-0107", alias: null, concepto: "Recolección de residuos", inactivo: true },
];

/** Las dos órdenes de pago del mes que se emite: una se paga, la otra se anula después de emitir (P2). */
type OrdenesDelMesEmitido = { readonly aAnular: string; readonly pagada: string };

// ─────────────────────────────────────────────────────────────────────────────────────────────────

const cliente = new pg.Client({ connectionString: url });
await cliente.connect();
const pool = new pg.Pool({ connectionString: url, max: 2 });
const db = crearDbMantenimiento(pool);

/** Lo que cada barrio deja para el resumen y para el período siguiente. */
type Sembrado = {
  readonly def: DefinicionBarrio;
  readonly id: string;
  readonly unidades: Array<{ id: string; manzana: string; lote: string }>;
  readonly conceptos: Map<string, string>;
  readonly catalogo: Map<string, string>;
};

try {
  // --- 1. Limpieza del demo anterior ------------------------------------------------------------
  //
  // Por **id fijo**, y por prefijo de nombre para los demos viejos sembrados antes de que el id lo
  // fuera. Las tablas a limpiar **se leen del catálogo** (toda tabla con `barrio_id`, y las de los
  // parámetros con `nodo_id`) en vez de escribirse a mano: la lista a mano se quedaba atrás cada vez
  // que nacía una tabla nueva, y con `session_replication_role = replica` —la puerta de mantenimiento
  // que permite borrar un período emitido— las claves foráneas no avisan: el barrio se borraba igual y
  // quedaban filas colgando. Este script solo corre en `local` (`exigirEntornoLocal`).
  await cliente.query("begin");
  const { rows: previos } = await cliente.query<{ path: string }>(
    "select path from tenant_node where tipo = 'administrador' and (id = $1 or nombre like 'Estudio Demo%')",
    [ADMINISTRADOR_ID],
  );
  const { rows: tablasConBarrio } = await cliente.query<{ tabla: string }>(
    `select c.table_name as tabla from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'barrio_id' and t.table_type = 'BASE TABLE'
        and c.table_name <> 'barrio'`,
  );
  for (const previo of previos) {
    const { rows: nodos } = await cliente.query<{ id: string }>(
      "select id from tenant_node where path = $1 or path like $1 || '.%' order by path desc",
      [previo.path],
    );
    const ids = nodos.map((n) => n.id);
    await cliente.query("set session_replication_role = replica");
    for (const { tabla } of tablasConBarrio) {
      await cliente.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [ids]);
    }
    await cliente.query("delete from barrio where barrio_id = any($1::uuid[])", [ids]);
    await cliente.query("delete from membership where tenant_node_id = any($1::uuid[])", [ids]);
    // Los parámetros de mora cuelgan del NODO (administración o barrio), no de `barrio_id` (ADR-0006).
    for (const tabla of ["parametro_anulacion", "parametro_valor", "subida_respaldo_solicitada"]) {
      await cliente.query(`delete from ${tabla} where nodo_id = any($1::uuid[])`, [ids]);
    }
    for (const id of ids) await cliente.query("delete from tenant_node where id = $1", [id]);
    await cliente.query("set session_replication_role = origin");
  }

  // --- 2. La administración y sus barrios (nodos de tenancía) -----------------------------------
  await cliente.query("insert into tenant_node (id, tipo, nombre) values ($1, 'administrador', $2)", [
    ADMINISTRADOR_ID,
    ADMINISTRADOR,
  ]);
  const nodoDe = new Map<DefinicionBarrio["clave"], string>();
  for (const def of BARRIOS) {
    const { rows } = await cliente.query<{ id: string }>(
      "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id",
      [def.nombre, ADMINISTRADOR_ID],
    );
    nodoDe.set(def.clave, rows[0]!.id);
  }
  const aromosId = nodoDe.get("aromos")!;

  // --- 3. Elenco ---------------------------------------------------------------------------------
  //
  // ⚠ PRECONDICIÓN DE SEGURIDAD (ADR-0002 §3.5): **ninguna membresía `propietario` ni `residente`**.
  // Hasta que exista el vínculo usuario→unidad, un rol de vecino no vería lo suyo: no vería nada, o
  // —si se abriera la policy sin el vínculo— el barrio entero. Hay un test del proyecto `db` que lo
  // verifica. El orden del arreglo es el orden de la pantalla de entrada (por `creado_at`; el seed
  // corre en una transacción y `now()` es constante, de ahí el desplazamiento por índice).
  const elenco: ReadonlyArray<{
    id: string;
    email: string;
    nombre: string;
    alcance: string;
    nodo: string;
    rol: RolDemo;
    genero: "f" | "m";
  }> = [
    {
      id: USUARIO_DEMO,
      email: "admin@estudio.test",
      nombre: "Valeria Ríos",
      alcance: "Ve todos los barrios del estudio, da de alta barrios nuevos y opera sin restricciones.",
      nodo: ADMINISTRADOR_ID,
      rol: "admin_barrio",
      genero: "f",
    },
    {
      id: OPERADOR_DEMO,
      email: "operador@estudio.test",
      nombre: "Martín Coria",
      alcance: "Ve un solo barrio. Carga gastos y aplica cargos; el resto no existe para él.",
      nodo: aromosId,
      rol: "operador",
      genero: "m",
    },
    {
      id: CONTADOR_DEMO,
      email: "contador@estudio.test",
      nombre: "Silvia Aguirre",
      alcance: "Ve Los Aromos y Las Cortaderas, sin modificar nada, y exporta los movimientos. No emite, no carga y no cobra.",
      nodo: aromosId,
      rol: "contador",
      genero: "f",
    },
  ];
  for (const [orden, persona] of elenco.entries()) {
    const descripcion = armarDescripcion({ rol: ETIQUETA_DE_ROL[persona.rol][persona.genero], alcance: persona.alcance });
    await cliente.query("insert into membership (user_id, tenant_node_id, rol) values ($1, $2, $3)", [
      persona.id,
      persona.nodo,
      persona.rol,
    ]);
    // `usuario_demo` no tiene grant de escritura para ningún rol de la app: esto funciona porque el
    // seed se conecta como dueño del esquema (candado del ADR-0002 §2.4).
    await cliente.query(
      `insert into usuario_demo (user_id, email, nombre, descripcion, creado_at)
       values ($1,$2,$3,$4, now() + make_interval(secs => $5::int))
       on conflict (user_id) do update
         set email = excluded.email, nombre = excluded.nombre,
             descripcion = excluded.descripcion, creado_at = excluded.creado_at`,
      [persona.id, persona.email, persona.nombre, descripcion, orden],
    );
  }
  // La contadora lleva dos barrios del estudio (ensayo de T2): así se ve el selector de barrios y
  // «Liquidación actual» con más de una fila sin ser la administración.
  await cliente.query("insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'contador')", [
    CONTADOR_DEMO,
    nodoDe.get("cortaderas")!,
  ]);

  // --- 4. Parámetros de mora (ADR-0006) ----------------------------------------------------------
  //
  // La administración nace con los valores iniciales del producto (trigger de `0057`): «Cobra: No»,
  // 5 días de gracia, «corre el inicio», $ 100, «Intereses primero». Sobre eso, lo de la maqueta T1:
  //   · la configuración general cobra 3 % mensual desde hace dos años y medio, con su respaldo;
  //   · un cambio general PROGRAMADO: 3,2 % desde el primer día del mes que viene;
  //   · Los Aromos con tasa PROPIA de 2,5 % (lo votó su asamblea): el cambio general no lo toca;
  //   · Las Cortaderas con «Cobra: No» propio: su revisión dice «No se cobra».
  // SQL directo y no `app.fijar_parametro`, que con razón no acepta fechas pasadas.
  const parametro = (
    nodo: string,
    clave: string,
    valor: unknown,
    /** Expresión SQL de fecha escrita en este archivo (relativa a hoy). Nunca llega de afuera. */
    desdeSql: string,
    motivo: string,
    respaldo: { tipo: string; referencia: string } | null = null,
  ) =>
    cliente.query(
      `insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga,
                                    respaldo_tipo, respaldo_referencia, creado_por)
       values ($1, $2, $3::jsonb, ${desdeSql}, $4, 'usuario', $5, $6, $7)`,
      [nodo, clave, JSON.stringify(valor), motivo, respaldo?.tipo ?? null, respaldo?.referencia ?? null, USUARIO_DEMO],
    );
  await parametro(ADMINISTRADOR_ID, "interes.tasa_compensatoria", "0.03", "current_date - 900",
    "Tasa acordada para todos los barrios del estudio.", { tipo: "otro", referencia: "Resolución de la administración 03/2024" });
  await parametro(ADMINISTRADOR_ID, "interes.cobra", true, "current_date - 900",
    "Lo aprobó la comisión de cada barrio, por nota a la administración.");
  await parametro(ADMINISTRADOR_ID, "interes.tasa_compensatoria", "0.032",
    "(date_trunc('month', current_date) + interval '1 month')::date",
    "Ajuste por la tasa activa del banco, informado a todos los barrios.", { tipo: "otro", referencia: "Resolución de la administración 11/2026" });
  await parametro(aromosId, "interes.tasa_compensatoria", "0.025", "current_date - 200",
    "Lo votó la asamblea ordinaria del barrio.", { tipo: "acta_asamblea", referencia: "Acta de asamblea ordinaria, punto 4" });
  await parametro(nodoDe.get("cortaderas")!, "interes.cobra", false, "current_date - 400",
    "La comisión decidió no cobrar interés mientras dure el plan de regularización.");
  // El Algarrobal imputa capital primero: el interés de un pago tardío queda como deuda (ADR-0009).
  await parametro(nodoDe.get("algarrobal")!, "imputacion.orden", "capital_primero", "current_date - 400",
    "Lo resolvió la asamblea: los pagos cancelan primero las cuotas.");

  // --- 5. Cada barrio: ficha, padrón, coeficientes, conceptos y catálogo --------------------------
  const sembrados: Sembrado[] = [];
  let personas = 0;
  for (const def of BARRIOS) {
    const barrioId = nodoDe.get(def.clave)!;
    await cliente.query(
      `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
                           servicios_internos_a_cargo_de, titularidad_espacios_comunes, denominacion_concepto,
                           reglamento_inscripto, pacto_ejecutividad, tiene_espacios_comunes_exclusivos,
                           tiene_consejo, tiene_fondo_reserva, domicilio_sede, medio_cobranza_clave,
                           dia_vencimiento, dias_segundo_vencimiento, dias_corte)
       values ($1,$2,'no_aplica',$3,$4,'urbanizacion','ente',$5, true, $6, true, true, $7, $8, $9, $10, $11, $12)`,
      [
        barrioId,
        def.figura,
        def.figura === "sa" ? "ure" : "loteo_abierto",
        def.municipio,
        def.denominacion,
        def.figura === "sa" ? true : null,
        def.gastos.some((g) => g[3] === true),
        def.domicilio,
        def.medio,
        def.configuracionVencimientos?.dia ?? null,
        def.configuracionVencimientos?.diasSegundo ?? null,
        def.configuracionVencimientos?.diasCorte ?? null,
      ],
    );
    await cliente.query(
      `insert into mandato_administracion (barrio_id, administrador_id, desde, notas)
       values ($1,$2, current_date - 900, 'Designada por asamblea (acta de ejemplo)')`,
      [barrioId, ADMINISTRADOR_ID],
    );
    await cliente.query(
      `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento, inscripto, notas)
       values ($1,'estatuto','Estatuto social (demo)', current_date - 3000, true,
               'Documento de ejemplo: no hay archivo cargado en el almacenamiento')`,
      [barrioId],
    );

    // El padrón, en lote (`unnest`): 2.000 viajes de ida y vuelta por fila serían tiempo de arranque
    // regalado cada vez que alguien siembra. El código de pago lo asigna la base fila por fila (0059).
    const traza = generarTraza(def.unidades, def.manzanas);
    const filas = traza.map((t) => {
      const r = azar();
      return {
        ...t,
        // ~8 % baldíos y ~6 % en construcción: pagan igual (art. 2077), y eso hay que poder mostrarlo.
        estado: r < 0.08 ? "baldio" : r < 0.14 ? "en_construccion" : "construido",
        superficie: String(entero(450, 1200)),
        catastro: `${def.catastro}-${t.manzana.padStart(3, "0")}-${t.lote.padStart(3, "0")}`,
      };
    });
    const { rows: ufs } = await cliente.query<{ id: string; manzana: string; lote: string; superficie: string }>(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2, nomenclatura_catastral)
       select $1, m, l, e::app.estado_unidad, s::numeric, c
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) with ordinality as t(m, l, e, s, c, o)
        order by o
       returning id, manzana, lote, superficie_m2::text as superficie`,
      [barrioId, filas.map((f) => f.manzana), filas.map((f) => f.lote), filas.map((f) => f.estado),
        filas.map((f) => f.superficie), filas.map((f) => f.catastro)],
    );

    // Número de acción y residente informativo (encargo 15), inventados. El residente es solo un dato:
    // la boleta y el envío siguen yendo al titular. Mail en `ejemplo.test`, que no puede ser de nadie.
    if (def.datosDePadron) {
      const d = def.datosDePadron;
      const conAccion = ufs.filter((_, i) => i % d.cada === 0);
      await cliente.query(
        `update unidad_funcional u set numero_accion = x.n
           from unnest($1::uuid[], $2::text[]) as x(id, n) where u.id = x.id`,
        [conAccion.map((u) => u.id), conAccion.map((_, i) => `${d.prefijoAccion}-${String(i + 1).padStart(4, "0")}`)],
      );
      const conResidente = ufs.filter((_, i) => i % d.residenteCada === 1);
      // Por índice y no con `elegir()`: no consume el azar con semilla, así el resto de la demo (los
      // titulares de este barrio y de los que siguen) sale igual que antes.
      const residentes = conResidente.map((_, i) => {
        const nombre = `${NOMBRES[(i * 5) % NOMBRES.length]} ${APELLIDOS[(i * 7 + 3) % APELLIDOS.length]}`;
        const [n, a] = nombre.split(" ") as [string, string];
        return {
          nombre,
          caracter: i % 3 === 2 ? "residente" : "inquilino",
          // Prefijo 000: no es una característica real (security-engineer, M5).
          telefono: `+54 351 000-${String(i % 10_000).padStart(4, "0")}`,
          mail: `${sinAcentos(n)}.${sinAcentos(a)}.residente${i + 1}@ejemplo.test`,
        };
      });
      await cliente.query(
        `update unidad_funcional u set residente_nombre = x.n, residente_caracter = x.c, residente_telefono = x.t, residente_email = x.m
           from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) as x(id, n, c, t, m) where u.id = x.id`,
        [conResidente.map((u) => u.id), residentes.map((r) => r.nombre), residentes.map((r) => r.caracter),
          residentes.map((r) => r.telefono), residentes.map((r) => r.mail)],
      );
    }

    // Titulares inventados: nombre y apellido al azar (con semilla), documento creciente —así es único
    // sin consultar nada— y un correo que sale del nombre y no puede ser de nadie (`ejemplo.test`).
    const titulares = ufs.map(() => {
      personas += 1;
      const nombre = `${elegir(NOMBRES)} ${elegir(APELLIDOS)}`;
      const [n, a] = nombre.split(" ") as [string, string];
      return {
        nombre,
        documento: String(20_000_000 + personas * 9_973 + entero(0, 9_000)),
        email: `${sinAcentos(n)}.${sinAcentos(a)}.${personas}@ejemplo.test`,
        telefono: `+54 351 555-${String(personas % 10_000).padStart(4, "0")}`,
      };
    });
    const { rows: obligados } = await cliente.query<{ id: string; numero_documento: string }>(
      `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, email, telefono)
       select $1, n, 'DNI', d, e, t from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as x(n, d, e, t)
       returning id, numero_documento`,
      [barrioId, titulares.map((t) => t.nombre), titulares.map((t) => t.documento),
        titulares.map((t) => t.email), titulares.map((t) => t.telefono)],
    );
    const obligadoPorDocumento = new Map(obligados.map((o) => [o.numero_documento, o.id]));
    await cliente.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       select $1, u, o, 'propietario', current_date - 800, true from unnest($2::uuid[], $3::uuid[]) as x(u, o)`,
      [barrioId, ufs.map((u) => u.id), titulares.map((t) => obligadoPorDocumento.get(t.documento))],
    );
    await cliente.query(
      `insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre, principal)
       select $1, u, e, n, true from unnest($2::uuid[], $3::text[], $4::text[]) as x(u, e, n)`,
      [barrioId, ufs.map((u) => u.id), titulares.map((t) => t.email), titulares.map((t) => t.nombre)],
    );

    // La historia del padrón, coherente (BL-025 e): la unidad se dio de alta el día desde el que rige su
    // titular más antiguo —antes la ficha decía «alta» hoy con un titular de hace dos años—, y cada
    // unidad tiene su evento de alta en el historial, firmado por la administradora. El trigger de
    // `padron_evento` pone `now()` y la identidad de la sesión: por eso va por la puerta de
    // mantenimiento, como el resto de la historia sembrada.
    await cliente.query("set session_replication_role = replica");
    await cliente.query(
      `update unidad_funcional u
          set created_at = (select min(uo.desde) from unidad_obligado uo where uo.unidad_funcional_id = u.id)::timestamp
                           at time zone b.zona_horaria + interval '9 hours'
         from barrio b
        where b.barrio_id = u.barrio_id and u.barrio_id = $1`,
      [barrioId],
    );
    await cliente.query(
      `insert into padron_evento (barrio_id, unidad_funcional_id, tipo, vigente_desde, detalle, rol, creado_por, created_at)
       select u.barrio_id, u.id, 'alta', (u.created_at at time zone b.zona_horaria)::date,
              'Alta de la unidad con su titular', 'admin_barrio', $2, u.created_at
         from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id
        where u.barrio_id = $1`,
      [barrioId, USUARIO_DEMO],
    );
    await cliente.query("set session_replication_role = origin");

    // Coeficientes. Al prorratear, por superficie (9 decimales, normalizados a 1, resto a la última:
    // el mismo helper que usa la liquidación). En cuota fija, partes iguales y **exactamente 1** cada
    // una: `app.validar_coeficientes` exige que no haya dos valores distintos en esa base.
    const base = def.modelo === "fija" ? "partes_iguales" : "superficie";
    const { rows: ver } = await cliente.query<{ id: string }>(
      `insert into coeficiente_version (barrio_id, base, descripcion, vigente_desde)
       values ($1, $2, $3, current_date - 900) returning id`,
      [barrioId, base, def.modelo === "fija" ? "Partes iguales: un lote, una cuota (estatuto)" : "Coeficientes del reglamento, proporcionales a la superficie"],
    );
    const partes = new Map(prorratear("10000000.00", ufs.map((u) => [u.id, u.superficie] as const)));
    const valores = ufs.map((u) =>
      def.modelo === "fija" ? "1" : `0.${aCentavos(partes.get(u.id) ?? "0.00").toString().padStart(9, "0")}`,
    );
    await cliente.query(
      `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor)
       select $1, $2, u, v::numeric from unnest($3::uuid[], $4::text[]) as x(u, v)`,
      [barrioId, ver[0]!.id, ufs.map((u) => u.id), valores],
    );
    await cliente.query("update coeficiente_version set cerrada = true where id = $1", [ver[0]!.id]);

    const conceptos = new Map<string, string>();
    for (const [nombre, , tipo, fondo] of def.gastos) {
      const { rows } = await cliente.query<{ id: string }>(
        `insert into concepto (barrio_id, nombre, tipo, es_fondo_reserva, clasificacion_fiscal)
         values ($1,$2,$3,$4,'sin_clasificar') returning id`,
        [barrioId, nombre, tipo, fondo === true],
      );
      conceptos.set(nombre, rows[0]!.id);
    }
    // Los conceptos que solo usan las órdenes de pago (no se cargan como gasto del mes anterior).
    if (CON_CIRCUITO.has(def.clave)) {
      for (const nombre of CONCEPTOS_DE_PROVEEDORES) {
        const { rows } = await cliente.query<{ id: string }>(
          `insert into concepto (barrio_id, nombre, tipo, es_fondo_reserva, clasificacion_fiscal)
           values ($1,$2,'ordinaria',false,'sin_clasificar') returning id`,
          [barrioId, nombre],
        );
        conceptos.set(nombre, rows[0]!.id);
      }
    }

    // El catálogo de cargos y descuentos. Sin él, la pantalla de cargos no tiene nada que ofrecer.
    const catalogo = new Map<string, string>();
    for (const c of [
      { nombre: "Bonificación por pago en término", clase: "descuento", metodo: "porcentaje", base: "expensa_ordinaria",
        financiamiento: "partida_presupuestada", monto: null, porcentaje: "7.500000", precio: null, tope: "30000.00" },
      { nombre: "Uso del club house", clase: "cargo", metodo: "precio_x_cantidad", base: "sin_base",
        financiamiento: null, monto: null, porcentaje: null, precio: "45000.00", tope: null },
      { nombre: "Alquiler de cancha de pádel", clase: "cargo", metodo: "precio_x_cantidad", base: "sin_base",
        financiamiento: null, monto: null, porcentaje: null, precio: "12000.00", tope: null },
      // Un descuento de monto fijo, para mostrar las dos formas.
      { nombre: "Descuento por obra a cargo del propietario", clase: "descuento", metodo: "monto_fijo", base: "sin_base",
        financiamiento: "absorbe_barrio", monto: "50000.00", porcentaje: null, precio: null, tope: null },
    ]) {
      const { rows: cRows } = await cliente.query<{ id: string }>(
        `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento)
         values ($1,$2,$3,$4,$5,'sin_clasificar',$6) returning id`,
        [barrioId, c.nombre, c.clase, c.metodo, c.base, c.financiamiento],
      );
      await cliente.query(
        `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje,
                                            precio_unitario, tope, vigente_desde)
         values ($1,$2,$3,$4,$5,$6,$7, current_date - 400)`,
        [barrioId, cRows[0]!.id, c.metodo, c.monto, c.porcentaje, c.precio, c.tope],
      );
      catalogo.set(c.nombre, cRows[0]!.id);
    }
    // Hasta dónde llega un operador sin pedirle a un administrador (ADR-0002 §7.3). Sin esta fila
    // `app.cbu_antes()` falla cerrado y el operador de la demo no puede aplicar ni un descuento.
    await cliente.query(
      `insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador,
                                             monto_max_cargo_operador, multiplo_confirmacion_cargo, vigente_desde)
       values ($1, '40000.00', 15.000000, '120000.00', null, current_date - 400)`,
      [barrioId],
    );

    // La cuota fija: las versiones anteriores primero (`app.cuota_fija_version_antes` cierra la
    // anterior al insertar la nueva) y la vigente desde el mes anterior.
    if (def.cuota) {
      const versiones = [...def.cuota.anteriores, def.cuota.vigente];
      for (const [i, importe] of versiones.entries()) {
        const desde = `${mesAtras(versiones.length - i)}-01`;
        const { rows } = await cliente.query<{ id: string }>(
          `insert into cuota_fija_version (barrio_id, descripcion, vigente_desde) values ($1, $2, $3::date) returning id`,
          [barrioId, `Cuota vigente desde ${desde.slice(0, 7)}`, desde],
        );
        await cliente.query(
          `insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe)
           select $1, $2, u, $4::numeric from unnest($3::uuid[]) as u`,
          [barrioId, rows[0]!.id, ufs.map((u) => u.id), importe],
        );
      }
    }

    sembrados.push({ def, id: barrioId, unidades: ufs, conceptos, catalogo });
  }
  await cliente.query("commit");

  // --- 6. Los meses: generar, emitir y cobrar por el MISMO camino que la aplicación ---------------
  //
  // Con los servicios reales (no con SQL a mano): si algo del circuito se rompe, se rompe acá antes
  // que en una demostración. Emitir requiere un usuario de sesión porque la firma la pone la base.
  const crearPeriodo = async (s: Sembrado, periodo: string, notas: string): Promise<string> => {
    const v = vencimientos(s.def.modelo, periodo);
    // La fecha de corte, contada desde el último vencimiento, en el barrio que la configura (`0078`).
    const corte = s.def.configuracionVencimientos ? sumarDias(v.segundo, s.def.configuracionVencimientos.diasCorte) : null;
    const { rows } = await cliente.query<{ id: string }>(
      `insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento, segundo_vencimiento, fecha_corte, notas)
       values ($1, $2, $3, $4::date, $5::date, $6::date, $7) returning id`,
      [s.id, periodo, s.def.modelo === "fija" ? "fija" : "variable", v.primero, v.segundo, corte, notas],
    );
    return rows[0]!.id;
  };
  const cargarGastos = async (s: Sembrado, periodoId: string, porcentaje: number) => {
    for (const [nombre, monto] of s.def.gastos) {
      await cliente.query(
        `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre)
         values ($1,$2,$3,$4,$5,'Proveedor contratado')`,
        [s.id, periodoId, s.conceptos.get(nombre), nombre, escalar(monto, porcentaje)],
      );
    }
  };
  /**
   * La firma de emisión es "ahora" (la pone la base). Para que el estado de cuenta se lea en orden
   * —el débito antes que los pagos que lo cancelan— se lleva al 1° del mes en que vence, por la puerta
   * de mantenimiento: es dato de la demo y el seed es el dueño del esquema.
   */
  const fecharEmision = async (s: Sembrado, periodoId: string, periodo: string) => {
    await cliente.query("set session_replication_role = replica");
    await cliente.query(
      "update periodo_expensa set emitida_at = ($2::date + time '09:00') at time zone b.zona_horaria from barrio b where id = $1 and b.barrio_id = periodo_expensa.barrio_id",
      [periodoId, diaDeEmision(s.def.modelo, periodo)],
    );
    await cliente.query("set session_replication_role = origin");
  };
  const emitir = async (s: Sembrado, periodoId: string, periodo: string, mora?: Parameters<typeof generarLiquidaciones>[1]) => {
    await conUsuario(db, USUARIO_DEMO, (tx) => generarLiquidaciones(tx, mora ?? { periodoId }));
    await conUsuario(db, USUARIO_DEMO, (tx) => emitirPeriodo(tx, { periodoId }));
    await fecharEmision(s, periodoId, periodo);
  };

  /**
   * Los cobros de un período, por unidad: la gran mayoría paga en término, algunos fuera de término y
   * algunos no pagan. `soloEnTermino` es para los meses históricos: ya se cobraron y no dejan deuda.
   * Los pagos entran como `extracto` —la transferencia o el pago en la red que llega por el banco—, que
   * es como entra la gran mayoría y no exige comprobante adjunto (un pago `manual` sí, `0032`). Se
   * registran por lote. Los que llegan **en término** se imputan con `app.resolver_imputacion` (no hay
   * interés que registrar); los que llegan **tarde**, uno por uno con el servicio de la pantalla
   * (`imputarPagoConInteres`, ADR-0009), que registra el interés que devengaron y lo imputa en el orden
   * del barrio. En Los Talas, el primer pago tardío se imputa con «No cobrar interés de este pago».
   */
  type Cobro = "en_termino" | "fuera_de_termino" | "impago";
  const cobrar = async (s: Sembrado, periodoId: string, periodo: string, soloEnTermino: boolean) => {
    const venc = vencimientos(s.def.modelo, periodo).primero;
    const destino: Array<{ uf: string; fecha: string; cobro: Cobro }> = [];
    for (const u of s.unidades) {
      const r = azar();
      const cobro: Cobro = soloEnTermino || r < 0.84 ? "en_termino" : r < 0.93 ? "fuera_de_termino" : "impago";
      if (cobro === "impago") {
        destino.push({ uf: u.id, fecha: "", cobro });
        continue;
      }
      const fecha = cobro === "en_termino" ? sumarDias(venc, -entero(0, 8)) : sumarDias(venc, entero(3, 19));
      destino.push({ uf: u.id, fecha: fecha > hoyIso ? hoyIso : fecha, cobro });
    }
    const pagan = destino.filter((d) => d.cobro !== "impago");
    const tarde = new Set(destino.filter((d) => d.cobro === "fuera_de_termino").map((d) => d.uf));
    // Dos sentencias y no un `with … insert` con la imputación en la misma: dentro de una sentencia,
    // la función no ve las filas que la propia sentencia acaba de insertar.
    const pagos = await conUsuario(db, USUARIO_DEMO, async (tx: DbConIdentidad) => {
      const { rows } = await tx.execute<{ id: string; unidad_funcional_id: string }>(sql`
        insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen)
        select l.barrio_id, l.unidad_funcional_id, l.total, t.fecha::date, 'extracto'
          from unnest(${arregloPg(pagan.map((p) => p.uf))}::uuid[], ${arregloPg(pagan.map((p) => p.fecha))}::text[]) as t(uf, fecha)
          join liquidacion l on l.periodo_id = ${periodoId} and l.unidad_funcional_id = t.uf
        returning id, unidad_funcional_id
      `);
      const enTermino = rows.filter((r) => !tarde.has(r.unidad_funcional_id)).map((r) => r.id);
      await tx.execute(sql`select app.resolver_imputacion(p) from unnest(${arregloPg(enTermino)}::uuid[]) as p`);
      return rows.filter((r) => tarde.has(r.unidad_funcional_id));
    });
    for (const [i, pago] of pagos.entries()) {
      // Los Talas y Los Aromos (encargo 9): el primer pago tardío, con «No cobrar interés de este pago».
      const noCobrar = (s.def.clave === "talas" || s.def.clave === "aromos") && i === 0;
      const r = await conUsuario(db, USUARIO_DEMO, (tx) =>
        imputarPagoConInteres(tx, {
          pagoId: pago.id,
          noCobrarInteres: noCobrar
            ? {
                motivo: "negociacion",
                detalle: "Acordado con el propietario: pagó tarde por un débito automático rechazado por el banco.",
                respaldoTipo: null,
                respaldoReferencia: null,
                respaldoAdjunto: null,
              }
            : null,
        }),
      );
      if (noCobrar) casos.noCobrar.push({ barrio: s.def.nombre, uf: pago.unidad_funcional_id, interes: r.interesDevengado });
    }
    return destino;
  };

  /**
   * El mes actual, con el saldo arrastrado: lo que cada unidad debe **en la cuenta corriente** al
   * generarlo (`saldo_uf`, lo lee el propio servicio), con origen `calculado` — así la base no lo cobra dos veces (`0060`) — y el
   * interés por mora desde el vencimiento del mes anterior hasta el 1° de este mes.
   */
  const emitirConSaldo = async (s: Sembrado, periodoId: string, periodo: string, anterior: string) => {
    const corte = `${MES_EN_CURSO}-01`;
    void anterior;
    await emitir(s, periodoId, periodo, { periodoId, fechaCorteMora: corte, origenSaldo: "calculado" });
  };

  /** El catálogo de proveedores de un barrio con circuito, por el servicio de la pantalla. */
  const sembrarProveedores = async (s: Sembrado): Promise<Map<ClaveProveedor, { id: string; razonSocial: string }>> => {
    const salida = new Map<ClaveProveedor, { id: string; razonSocial: string }>();
    for (const [i, p] of PROVEEDORES_DEMO.entries()) {
      const semilla = (s.def.clave === "aromos" ? 61_000_000 : 62_000_000) + i * 104_729;
      const proveedor = await conUsuario(db, USUARIO_DEMO, (tx) =>
        registrarProveedor(tx, {
          barrioId: s.id,
          razonSocial: p.razonSocial,
          cuit: cuitInventado(p.prefijo, semilla),
          condicionFiscal: p.condicionFiscal,
          contacto: p.contacto,
          cbu: cbuDePrueba(semilla),
          alias: p.alias,
        }),
      );
      salida.set(p.clave, { id: proveedor.id, razonSocial: proveedor.razonSocial });
    }
    return salida;
  };

  /** Carga una orden de pago en `pendiente` con la identidad de quien la carga. */
  const cargarOrden = async (
    s: Sembrado,
    quien: string,
    proveedores: Map<ClaveProveedor, { id: string }>,
    clave: ClaveProveedor,
    periodoId: string,
    factura: string,
    descripcion: string,
    monto: string,
    /** «Mes del servicio» (`YYYY-MM`, encargo 11, BL-030 k), solo informativo. */
    mesServicio: string | null = null,
  ): Promise<string> => {
    const def = PROVEEDORES_DEMO.find((p) => p.clave === clave)!;
    const orden = await conUsuario(db, quien, (tx) =>
      registrarOrdenPago(tx, {
        proveedorId: proveedores.get(clave)!.id,
        periodoId,
        conceptoId: s.conceptos.get(def.concepto)!,
        numeroFactura: factura,
        descripcion,
        monto,
        mesServicio,
      }),
    );
    return orden.id;
  };
  const aprobar = (ordenPagoId: string) => conUsuario(db, USUARIO_DEMO, (tx) => aprobarOrdenPago(tx, { ordenPagoId }));

  const proveedoresDe = new Map<string, Map<ClaveProveedor, { id: string; razonSocial: string }>>();
  const ordenesDelMesEmitido = new Map<string, OrdenesDelMesEmitido>();
  /** Lo que el resumen de consola dice para probar en vivo (unidad y proveedor de cada prueba). */
  const pruebas: string[] = [];

  const resumen: Array<{ s: Sembrado; cobros: Cobro[]; anterior: string; actual: string }> = [];
  /** Los casos del circuito de la deuda que la demo tiene que mostrar (para el resumen de consola). */
  const casos = {
    noCobrar: [] as Array<{ barrio: string; uf: string; interes: string }>,
    condonacionParcial: [] as Array<{ barrio: string; uf: string; devengado: string; condonado: string }>,
    /** Encargo 11 (BL-030 j): un pago con «No cobrar el interés» en sus dos partes. */
    dosPartes: [] as Array<{ barrio: string; unidad: string; delPago: string; anterior: string }>,
    /** T2: el aumento de cuota cargado (Configuración del barrio › Cuota). */
    aumento: null as { barrio: string; desde: string } | null,
    /** T2: la unidad nueva de Los Aromos sin coeficiente (lo que lo deja «Preparando»). */
    altaSinCoeficiente: null as string | null,
  };
  for (const s of sembrados) {
    // En cuota fija el período se cobra dentro del mes: el "mes actual" es el mes en curso. Al
    // prorratear, el mes actual que se cobra es el que terminó.
    const actual = s.def.modelo === "fija" ? mesAtras(0) : mesAtras(1);
    const anterior = s.def.modelo === "fija" ? mesAtras(1) : mesAtras(2);

    // Los meses históricos (solo Los Talas): la tira de la evolución de la cuota. Ya cobrados.
    for (let i = s.def.cuota?.anteriores.length ?? 0; i >= 1; i--) {
      const mes = mesAtras(i + 1);
      const id = await crearPeriodo(s, mes, "Mes histórico: da la evolución de la cuota");
      await emitir(s, id, mes);
      await cobrar(s, id, mes, true);
    }

    const idAnterior = await crearPeriodo(s, anterior, "Mes anterior: emitido y cobrado");
    await cargarGastos(s, idAnterior, 96);
    await emitir(s, idAnterior, anterior);
    const cobros = await cobrar(s, idAnterior, anterior, false);

    // Un pago anulado (encargo 9): el primero en término del mes anterior, como un débito que el banco
    // revirtió. Por el servicio de la pantalla: anula también a qué se imputó (BL-022 a) y la deuda
    // vuelve a la unidad, que la arrastra en la boleta del mes actual.
    let ufDelPagoAnulado: string | null = null;
    if (CON_CIRCUITO.has(s.def.clave)) {
      const uf = cobros.find((c) => c.cobro === "en_termino")!.uf;
      ufDelPagoAnulado = uf;
      const { rows } = await cliente.query<{ id: string }>(
        `select p.id from pago p where p.unidad_funcional_id = $1 and p.anulado_at is null order by p.fecha limit 1`,
        [uf],
      );
      await conUsuario(db, USUARIO_DEMO, (tx) =>
        anularPago(tx, { pagoId: rows[0]!.id, motivo: "El banco revirtió la transferencia: la cuenta de origen estaba cerrada." }),
      );
    }

    // El Algarrobal imputa con «Capital primero»: a quien pagó tarde le queda el interés como deuda, y
    // a la primera de esas unidades la administración le condona la mitad (ADR-0009).
    if (s.def.clave === "algarrobal") {
      const pendiente = await conUsuario(db, USUARIO_DEMO, async (tx) => {
        const { rows } = await tx.execute<{ uf: string; pendiente: string }>(sql`
          select d.unidad_funcional_id as uf, sum(app.interes_pendiente(d.id))::numeric(14,2)::text as pendiente
            from interes_devengado d join unidad_funcional u on u.id = d.unidad_funcional_id
           where d.barrio_id = ${s.id} and d.monto > 0
           -- Por el código de pago y no por el id: el id cambia en cada siembra y la demo no.
           group by d.unidad_funcional_id, u.codigo_pago_numero order by u.codigo_pago_numero limit 1
        `);
        return rows[0];
      });
      if (pendiente) {
        const mitad = deCentavos(aCentavos(pendiente.pendiente) / 2n);
        await conUsuario(db, USUARIO_DEMO, (tx) =>
          condonarInteres(tx, {
            unidadFuncionalId: pendiente.uf,
            monto: mitad,
            motivo: "comision_asamblea",
            detalle: "La comisión directiva resolvió condonar la mitad del interés por la demora del correo.",
            respaldoTipo: "acta_comision",
            respaldoReferencia: "Acta de comisión directiva de ejemplo, punto 2",
            respaldoAdjunto: null,
            confirmarCondonacion: true,
          }),
        );
        casos.condonacionParcial.push({ barrio: s.def.nombre, uf: pendiente.uf, devengado: pendiente.pendiente, condonado: mitad });
      }
    }

    const idActual = await crearPeriodo(s, actual, "Mes actual: emitido, con el saldo y el interés de lo impago");
    await cargarGastos(s, idActual, 100);
    // La bonificación por pago en término, a quienes pagaron en término el mes anterior; y un par de
    // usos del club house. Los carga una PERSONA: van con identidad, la firma la pone la base.
    const bonificacion = s.catalogo.get("Bonificación por pago en término")!;
    const clubHouse = s.catalogo.get("Uso del club house")!;
    // Sin la unidad del pago anulado: ya no pagó en término (revisión de código).
    const enTermino = cobros.filter((c) => c.cobro === "en_termino" && c.uf !== ufDelPagoAnulado).map((c) => c.uf);
    await conUsuario(db, USUARIO_DEMO, async (tx) => {
      await tx.execute(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, cantidad, detalle)
        select ${idActual}, u, ${bonificacion}, ${`${MES_EN_CURSO}-01`}::date, null, 'Pagó en término el mes anterior'
          from unnest(${arregloPg(enTermino)}::uuid[]) as u
      `);
      for (const u of s.unidades.slice(0, 2)) {
        await tx.execute(sql`
          insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, cantidad, detalle)
          values (${idActual}, ${u.id}, ${clubHouse}, ${`${MES_EN_CURSO}-01`}::date, 1, 'Reserva del club house — 1 jornada')
        `);
      }
    });
    // Proveedores y las dos órdenes del mes que se emite (encargo 9): se aprueban ANTES de emitir, así
    // su gasto entra en este mes. Una se paga y la otra se anula después de emitir (P2: su ajuste cae
    // en el borrador del mes en curso).
    if (CON_CIRCUITO.has(s.def.clave)) {
      const proveedores = await sembrarProveedores(s);
      proveedoresDe.set(s.id, proveedores);
      const aAnular = await cargarOrden(s, USUARIO_DEMO, proveedores, "jardineria", idActual, "B-0003-00004512",
        "Poda de altura en los espacios verdes del ingreso", "1240000.00");
      // Encargo 11 (BL-030 k): en Los Aromos, la reparación es del mes anterior y se paga en este. El
      // «Mes del servicio» sale junto al gasto en la orden, en Gastos, en la boleta y en el informe.
      const pagada = await cargarOrden(s, USUARIO_DEMO, proveedores, "electricidad", idActual, "A-0002-00018733",
        "Reparación del tablero eléctrico del club house", "385000.00", s.def.clave === "aromos" ? anterior : null);
      await aprobar(aAnular);
      await aprobar(pagada);
      ordenesDelMesEmitido.set(s.id, { aAnular, pagada });
    }
    await emitirConSaldo(s, idActual, actual, anterior);
    resumen.push({ s, cobros: cobros.map((c) => c.cobro), anterior, actual });
  }

  // --- 7. Los Aromos: un período EN BORRADOR, para mostrar el trabajo -----------------------------
  //
  // Los emitidos demuestran el resultado; este, las pantallas de carga (gastos, cargos, generar el
  // borrador, emitir). Queda sin liquidaciones: que "Generar el borrador" tenga algo que hacer es
  // parte de lo que hay que poder mostrar. La extraordinaria va **sin acta**: la base la marca
  // `sin_respaldo_asamblea` y la pantalla tiene que mostrarlo (doc 08 §A.0 punto 2).
  const aromos = sembrados.find((s) => s.def.clave === "aromos")!;
  const idBorrador = await crearPeriodo(aromos, MES_EN_CURSO, "Período en curso: gastos cargándose, todavía sin liquidar");
  const { rows: porton } = await cliente.query<{ id: string }>(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Portón de acceso (obra)', 'extraordinaria', 'sin_clasificar') returning id`,
    [aromos.id],
  );
  for (const [conceptoId, descripcion, monto] of [
    [aromos.conceptos.get("Seguridad y vigilancia")!, "Servicio de vigilancia 24 h", "52480000.00"],
    [aromos.conceptos.get("Mantenimiento de espacios verdes")!, "Corte de césped (primera quincena)", "7130250.00"],
    [porton[0]!.id, "Reparación de urgencia del portón (sin asamblea previa)", "1410000.00"],
  ] as const) {
    await cliente.query(
      `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre, comprobante)
       values ($1,$2,$3,$4,$5,'Proveedor de ejemplo S.A.','FC-B-0001-00012345')`,
      [aromos.id, idBorrador, conceptoId, descripcion, monto],
    );
  }
  // Un cargo y un descuento con el servicio de escritura real y **con la identidad del operador**:
  // prueba en cada siembra que el operador llega al tope de `limite_aplicacion_barrio`.
  await conUsuario(db, OPERADOR_DEMO, async (tx) => {
    await aplicarConceptoAUnidad(tx, {
      periodoId: idBorrador,
      unidadFuncionalId: aromos.unidades[4]!.id,
      conceptoBoletaId: aromos.catalogo.get("Uso del club house")!,
      fechaHecho: hoyIso,
      cantidad: "2",
      detalle: "Reserva del club house — 2 jornadas (cumpleaños)",
      origenEvaluacion: "carga_manual",
    });
    await aplicarConceptoAUnidad(tx, {
      periodoId: idBorrador,
      unidadFuncionalId: aromos.unidades[1]!.id,
      conceptoBoletaId: aromos.catalogo.get("Bonificación por pago en término")!,
      fechaHecho: hoyIso,
      cantidad: null,
      detalle: "Sin saldo pendiente al cierre del período anterior",
      origenEvaluacion: "carga_manual",
    });
  });

  // --- 7a. Las Cortaderas también con el mes en curso EN BORRADOR (encargo 9) ---------------------
  const cortaderas = sembrados.find((s) => s.def.clave === "cortaderas")!;
  const idBorradorCortaderas = await crearPeriodo(cortaderas, MES_EN_CURSO, "Período en curso: gastos y órdenes de pago cargándose");
  for (const [concepto, descripcion, proveedor, comprobante, monto] of [
    ["Seguridad y vigilancia", "Servicio de vigilancia 24 h", "Centinela Seguridad Privada S.A.", "A-0005-00031207", "38150000.00"],
    ["Mantenimiento de espacios verdes", "Corte de césped y desmalezado", "Verde Monte Parques y Jardines", "C-0001-00000877", "4510000.00"],
    ["Mantenimiento del club house", "Pintura del salón principal", "Proveedor de ejemplo S.A.", "B-0001-00002231", "1260000.00"],
  ] as const) {
    await cliente.query(
      `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre, comprobante)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [cortaderas.id, idBorradorCortaderas, cortaderas.conceptos.get(concepto), descripcion, monto, proveedor, comprobante],
    );
  }

  // --- 7a'. El circuito de proveedores y órdenes de pago, con los dos borradores ya abiertos -------
  //
  // Todo por los servicios de la pantalla y con la identidad de quien lo haría: el operador de Los
  // Aromos carga, la administradora aprueba (no hay cuatro ojos en la demo, así que en Las
  // Cortaderas la administradora hace las dos cosas).
  for (const [s, idBorradorDelBarrio] of [
    [aromos, idBorrador],
    [cortaderas, idBorradorCortaderas],
  ] as const) {
    const proveedores = proveedoresDe.get(s.id)!;
    const delMesEmitido = ordenesDelMesEmitido.get(s.id)!;
    const carga = s.def.clave === "aromos" ? OPERADOR_DEMO : USUARIO_DEMO;
    const mes = formatearMes(MES_EN_CURSO);

    // La del mes emitido: una pagada y otra anulada (su ajuste negativo va a este borrador, P2).
    await conUsuario(db, USUARIO_DEMO, (tx) => marcarOrdenPagada(tx, { ordenPagoId: delMesEmitido.pagada, medioPago: "transferencia" }));
    await conUsuario(db, USUARIO_DEMO, (tx) =>
      anularOrdenPago(tx, {
        ordenPagoId: delMesEmitido.aAnular,
        motivo: "La poda se había facturado dos veces: esta factura es un duplicado de la anterior.",
      }),
    );

    // Las del mes en curso: dos pendientes, una aprobada (su gasto entra al borrador) y una rechazada.
    await cargarOrden(s, carga, proveedores, "limpieza", idBorradorDelBarrio, "B-0004-00007810",
      `Limpieza de espacios comunes de ${mes}`, "640000.00");
    await cargarOrden(s, carga, proveedores, "pileta", idBorradorDelBarrio, "C-0002-00000391",
      "Puesta a punto de la pileta para la temporada", "910000.00");
    const aprobada = await cargarOrden(s, carga, proveedores, "contador", idBorradorDelBarrio, "A-0001-00002544",
      `Honorarios contables de ${mes}`, "275000.00");
    await aprobar(aprobada);
    const aRechazar = await cargarOrden(s, carga, proveedores, "seguridad", idBorradorDelBarrio, "A-0005-00031388",
      "Adicional de vigilancia por evento del fin de semana", "480000.00");
    await conUsuario(db, USUARIO_DEMO, (tx) =>
      rechazarOrdenPago(tx, { ordenPagoId: aRechazar, motivo: "No hubo evento ese fin de semana: el adicional no corresponde." }),
    );

    // El proveedor reemplazado queda en el catálogo, desactivado.
    await conUsuario(db, USUARIO_DEMO, (tx) => desactivarProveedor(tx, { proveedorId: proveedores.get("residuos")!.id }));

    // Un cargo vigente y uno anulado (se cargó a la unidad equivocada).
    await conUsuario(db, USUARIO_DEMO, async (tx) => {
      await aplicarConceptoAUnidad(tx, {
        periodoId: idBorradorDelBarrio,
        unidadFuncionalId: s.unidades[6]!.id,
        conceptoBoletaId: s.catalogo.get("Alquiler de cancha de pádel")!,
        fechaHecho: hoyIso,
        cantidad: "3",
        detalle: "Alquiler de cancha de pádel — 3 turnos",
        origenEvaluacion: "carga_manual",
      });
      const equivocada = await aplicarConceptoAUnidad(tx, {
        periodoId: idBorradorDelBarrio,
        unidadFuncionalId: s.unidades[7]!.id,
        conceptoBoletaId: s.catalogo.get("Uso del club house")!,
        fechaHecho: hoyIso,
        cantidad: "1",
        detalle: "Reserva del club house — 1 jornada",
        origenEvaluacion: "carga_manual",
      });
      await anularAplicacion(tx, { aplicacionId: equivocada.id, motivo: "Se cargó a la unidad equivocada: la reserva era de la unidad de al lado." });
    });

    // Qué usar en cada prueba en vivo (para el resumen de consola).
    const { rows: deudoras } = await cliente.query<{ manzana: string; lote: string; codigo: string; saldo: string }>(
      `select u.manzana, u.lote, u.codigo_pago_numero::text as codigo, s.saldo_actual::text as saldo
         from saldo_uf s join unidad_funcional u on u.id = s.unidad_funcional_id
        where u.barrio_id = $1 and s.saldo_actual > 0
          and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                       where l.unidad_funcional_id = u.id and pe.estado = 'emitida' and pe.primer_vencimiento < current_date
                         and not exists (select 1 from pago_imputacion pi where pi.liquidacion_id = l.id and pi.anulado_at is null))
        order by u.codigo_pago_numero limit 2`,
      [s.id],
    );
    const etiqueta = (d: { manzana: string; lote: string; codigo: string; saldo: string } | undefined) =>
      d ? `Mza ${d.manzana} · Lote ${d.lote} (código ${d.codigo}, debe $ ${d.saldo})` : "—";
    pruebas.push(
      `    ${s.def.nombre}:`,
      `      · pago tardío: ${etiqueta(deudoras[0])}`,
      `      · «No cobrar interés»: ${etiqueta(deudoras[1])}`,
      `      · OP para aprobar: ${proveedores.get("limpieza")!.razonSocial} · OP para rechazar: ${proveedores.get("pileta")!.razonSocial}`,
      `      · gasto de OP en el borrador: honorarios de ${proveedores.get("contador")!.razonSocial} (y el ajuste de ${proveedores.get("jardineria")!.razonSocial})`,
      `      · gasto manual: «${s.def.clave === "aromos" ? "Corte de césped (primera quincena)" : "Corte de césped y desmalezado"}»`,
    );
  }

  // --- 7d. T2 (ADR-0011): Los Talas con un aumento de cuota cargado ---------------------------------
  // El directorio aprobó un aumento que rige desde el mes que viene: se carga por el mismo servicio
  // que «Aplicar un aumento» de Configuración del barrio, por porcentaje con redondeo y con su acta.
  // Queda como cambio programado en el historial; el mes en curso, ya emitido, no cambia.
  const talas = sembrados.find((s) => s.def.clave === "talas")!;
  const { rows: proximo } = await cliente.query<{ mes: string }>(
    `select to_char(date_trunc('month', now() at time zone zona_horaria) + interval '1 month', 'YYYY-MM') as mes
       from barrio where barrio_id = $1`,
    [talas.id],
  );
  await conUsuario(db, USUARIO_DEMO, (tx) =>
    definirCuotaFija(tx, {
      barrioId: talas.id,
      rigeDesde: proximo[0]!.mes,
      descripcion: "Acta de directorio N.º 15 (demo)",
      forma: "porcentaje",
      porcentaje: "8",
      redondeo: "centena",
    }),
  );
  casos.aumento = { barrio: talas.def.nombre, desde: proximo[0]!.mes };

  // --- 7e. T2: Los Aromos «Preparando» con un bloqueo de verdad ------------------------------------
  // Una unidad dada de alta este mes, que todavía no está en la versión de coeficientes: así el mes no
  // se puede repartir hasta cargar la versión nueva (Padrón › Coeficientes). Es lo que hace que Los
  // Aromos quede «Preparando» y Las Cortaderas «Listo para emitir» en «Liquidación actual». El gasto
  // extraordinario sin respaldo de asamblea de Los Aromos avisa, no bloquea (0007).
  const { rows: alta } = await cliente.query<{ manzana: string; lote: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     select $1, u.manzana, (max(u.lote::int) + 1)::text, 'baldio'
       from unidad_funcional u where u.barrio_id = $1 and u.lote ~ '^[0-9]+$'
      group by u.manzana order by u.manzana desc limit 1
     returning manzana, lote`,
    [aromos.id],
  );
  casos.altaSinCoeficiente = alta[0] ? `Mza ${alta[0].manzana} · Lote ${alta[0].lote}` : null;

  // --- 7c. Encargo 11: «No cobrar el interés» en sus dos partes, en Los Aromos ---------------------
  // Una unidad que debe interés ya facturado (lo trae la boleta del mes actual) y capital vencido paga
  // hoy su capital, con los dos renglones marcados: se condonan el interés de este atraso y el
  // anterior. Por el mismo servicio que usa la pantalla, como la administración, pero con origen
  // «extracto» (el seed no sube comprobantes). El pago queda con interés
  // condonado vigente: un operador ve «Lo anula un administrador…» en lugar de «Anular» (0070).
  {
    const { rows: candidata } = await cliente.query<{ id: string; manzana: string; lote: string; hoy: string }>(
      `select u.id, u.manzana, u.lote, (now() at time zone b.zona_horaria)::date::text as hoy
         from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id
        where u.barrio_id = $1
          and exists (select 1 from interes_devengado d where d.unidad_funcional_id = u.id and d.monto > 0
                         and app.interes_pendiente(d.id) > 0)
          and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                       where l.unidad_funcional_id = u.id and pe.estado in ('emitida', 'distribuida')
                         and pe.primer_vencimiento < (now() at time zone b.zona_horaria)::date
                         and app.capital_pendiente(l.id) > 0)
          and not exists (select 1 from pago p where p.unidad_funcional_id = u.id and p.anulado_at is null
                             and p.fecha >= (now() at time zone b.zona_horaria)::date - 1)
          -- Siempre la misma unidad, para que la guía de prueba pueda nombrarla (ensayo de T2).
          and u.manzana = '2' and u.lote = '12'`,
      [aromos.id],
    );
    const unidad = candidata[0];
    // Si el escenario cambiara y Mza 2 · Lote 12 dejara de deber interés, el seed lo dice en vez de
    // elegir otra en silencio: la guía de prueba la nombra.
    if (!unidad) throw new Error("seed: Mza 2 · Lote 12 de Los Aromos ya no debe interés y capital vencido; el caso «No cobrar el interés» en dos partes necesita esa unidad");
    {
      const vista = await conUsuario(db, USUARIO_DEMO, (tx) =>
        vistaPreviaDelPago(tx, { unidadFuncionalId: unidad.id, fecha: unidad.hoy, monto: "0.00" }),
      );
      const pago = await conUsuario(db, USUARIO_DEMO, (tx) =>
        registrarEImputarPago(tx, {
          pago: { unidadFuncionalId: unidad.id, obligadoId: null, monto: vista.capital, fecha: unidad.hoy, origen: "extracto", comprobanteAdjunto: null },
          confirmarPagoConInteres: true,
          noCobrarInteres: {
            motivo: "comision_asamblea",
            detalle: "La comisión resolvió no cobrar el interés a quien regularizara la deuda en el mes.",
            respaldoTipo: "acta_comision",
            respaldoReferencia: "Acta de comisión directiva de ejemplo, punto 4",
            respaldoAdjunto: null,
          },
          condonar: { delPago: true, anterior: true },
        }),
      );
      casos.dosPartes.push({
        barrio: aromos.def.nombre,
        unidad: `Mza ${unidad.manzana} · Lote ${unidad.lote}`,
        delPago: pago.interesCondonadoDelPago,
        anterior: pago.interesCondonadoAnterior,
      });
    }
  }

  // --- 7b. Los Ceibos: un barrio RECIÉN CREADO desde la pantalla (T3, ADR-0010) ------------------
  //
  // S.A., cuota fija, «una cuenta por unidad». Se crea por el MISMO camino que la pantalla
  // (`crearBarrio`, la importación de la planilla y la cuota), con la identidad de la administradora,
  // y tiene su primer período (el mes en curso) emitido para poder bajar la boleta con la cuenta de la
  // unidad. Las cuentas son de la lista cerrada de demostración (`inercia.ts`): el medio
  // transferencia-QR no imprime ninguna otra. Va al final y con su propio generador: los cuatro
  // barrios de arriba no cambian.
  const ceibos = await conUsuario(db, USUARIO_DEMO, (tx) =>
    crearBarrioPadron(tx, {
      administradorId: ADMINISTRADOR_ID,
      nombre: "Barrio Demo Los Ceibos",
      razonSocial: "Los Ceibos Country S.A. (demo)",
      cuit: "",
      municipio: "Malagueño",
      figuraJuridica: "sa",
      modelo: "fija",
      diaVencimiento: "10",
      primerPeriodo: MES_EN_CURSO,
      identificacionPago: "cuenta_por_unidad",
      cuentaCbu: cuentaDeDemostracion(41),
      cuentaAlias: "",
      recaudador: "SIRO · Banco Roela",
      medioCobranza: "transferencia-qr",
      codigoPagoPrefijo: "",
      mandatoDesde: `${MES_EN_CURSO}-01`,
      actaAdjunto: "",
      adecuadoArt2075: "",
      encuadreUrbanistico: "ure",
      serviciosInternos: "urbanizacion",
      reglamentoInscripto: "",
    }),
  );
  const azarCeibos = generador(SEMILLA + 7);
  const elegirCeibos = <T>(lista: readonly T[]): T => lista[Math.floor(azarCeibos() * lista.length)] as T;
  const filasCeibos: string[][] = [[...columnasDelPadron(true)]];
  const col = (v: Partial<Record<ColumnaPadron, string>>) => columnasDelPadron(true).map((c) => v[c] ?? "");
  let cuentaN = 0;
  for (let m = 1; m <= 4; m++) {
    for (let l = 1; l <= 10; l++) {
      // Mza 1 · Lote 4: dos titulares y cuenta propia (el caso de la maqueta). Una de cada siete,
      // sin cuenta propia: su boleta imprime la cuenta padre con el código de pago.
      const sinCuenta = !(m === 1 && l === 4) && (m * 10 + l) % 7 === 0;
      const conCuenta = !sinCuenta && cuentaN < 34;
      if (conCuenta) cuentaN++;
      const nombre = `${elegirCeibos(NOMBRES)} ${elegirCeibos(APELLIDOS)}`;
      const [n, a] = nombre.split(" ") as [string, string];
      const documento = String(30_000_000 + (m * 100 + l) * 7_919);
      filasCeibos.push(
        col({
          manzana: String(m),
          lote: String(l),
          superficie_m2: `${600 + ((m * 37 + l * 11) % 250)},00`,
          estado: (m + l) % 9 === 0 ? "Baldío" : "Construida",
          nomenclatura: `13-05-18-${String(m).padStart(3, "0")}-${String(l).padStart(3, "0")}`,
          titular: m === 1 && l === 4 ? "Pablo Ferreyra" : nombre,
          caracter: "Propietario",
          cuit_o_dni: m === 1 && l === 4 ? "20111111112" : documento,
          recibe_boleta: "sí",
          mail: m === 1 && l === 4 ? "pablo.ferreyra@ejemplo.test" : `${sinAcentos(n)}.${sinAcentos(a)}.ceibos${m}${l}@ejemplo.test`,
          cbu_unidad: conCuenta ? cuentaDeDemostracion(cuentaN) : "",
          alias_unidad: conCuenta ? aliasDeDemostracion(cuentaN) : "",
          // Dos unidades traen deuda de antes del sistema.
          saldo_inicial: (m === 2 && l === 3) || (m === 3 && l === 8) ? "48200,00" : "",
        }),
      );
      if (m === 1 && l === 4) {
        filasCeibos.push(col({ manzana: "1", lote: "4", titular: "Ana Ledesma", caracter: "Propietario", cuit_o_dni: "27222222", mail: "ana.ledesma@ejemplo.test" }));
      }
    }
  }
  const importados = await conUsuario(db, USUARIO_DEMO, (tx) =>
    confirmarImportacion(tx, { barrioId: ceibos.barrioId, archivo: "padron-los-ceibos.xlsx", filas: filasCeibos }),
  );
  await conUsuario(db, USUARIO_DEMO, (tx) =>
    definirCuotaFija(tx, { barrioId: ceibos.barrioId, rigeDesde: MES_EN_CURSO, forma: "importe", importe: "185000.00", descripcion: "Acta de directorio 1 (demo)" }),
  );
  const { rows: periodoCeibos } = await cliente.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento, segundo_vencimiento, notas)
     values ($1, $2, 'fija', $3::date, $4::date, 'Primer período del barrio') returning id`,
    [ceibos.barrioId, MES_EN_CURSO, `${MES_EN_CURSO}-10`, `${MES_EN_CURSO}-20`],
  );
  // Como «Generar el borrador» de la pantalla: saldo calculado (las dos unidades con saldo inicial lo
  // llevan en su primera boleta, con origen «carga manual»).
  await conUsuario(db, USUARIO_DEMO, (tx) => generarLiquidaciones(tx, { periodoId: periodoCeibos[0]!.id, origenSaldo: "calculado" }));
  await conUsuario(db, USUARIO_DEMO, (tx) => emitirPeriodo(tx, { periodoId: periodoCeibos[0]!.id }));

  // --- 8. Resumen para la consola ----------------------------------------------------------------
  const lineas: string[] = [];
  for (const { s, cobros, anterior, actual } of resumen) {
    const { rows } = await cliente.query<{ con_interes: string; interes: string }>(
      `select count(*) filter (where l.interes_mora > 0)::text as con_interes, coalesce(sum(l.interes_mora), 0)::text as interes
         from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
        where pe.barrio_id = $1 and pe.periodo = $2`,
      [s.id, actual],
    );
    const cuenta = (c: Cobro) => cobros.filter((x) => x === c).length;
    lineas.push(
      `  ${s.def.nombre.padEnd(28)} ${(s.def.figura === "sa" ? "S.A." : "Asoc. civil").padEnd(11)} ` +
        `${(s.def.modelo === "fija" ? "cuota fija" : "coeficiente").padEnd(11)} ${String(s.unidades.length).padStart(3)} UF  ` +
        `${s.def.medio.padEnd(16)}\n` +
        `      ${anterior}: ${cuenta("en_termino")} en término, ${cuenta("fuera_de_termino")} fuera de término, ` +
        `${cuenta("impago")} impagos → ${actual}: ${rows[0]?.con_interes} con interés ($ ${rows[0]?.interes})`,
    );
  }
  console.log(`Modo demo listo — ${ADMINISTRADOR} (${sembrados.reduce((n, s) => n + s.unidades.length, 0)} unidades)
${lineas.join("\n")}

  Elenco (se entra en /entrar — sin propietarios ni residentes, a propósito):
${elenco.map((p) => `    · ${p.nombre.padEnd(16)} ${p.rol.padEnd(13)} ${p.email}`).join("\n")}

  Los Aromos y Las Cortaderas tienen además el período ${MES_EN_CURSO} EN BORRADOR (gastos a mano y de
    órdenes de pago, cargos) y el circuito de proveedores: 7 proveedores (1 inactivo) y órdenes de pago
    pendientes (2), aprobada, pagada, rechazada y anulada de un mes emitido (con su ajuste). Para probar:
${pruebas.join("\n")}

  Alta de barrio y padrón (T3): Barrio Demo Los Ceibos, recién creado — ${importados.altas} unidades por planilla,
    cuenta por unidad (algunas sin cuenta propia), ${MES_EN_CURSO} emitido. Mza 1 · Lote 4 tiene dos titulares.
    Planilla para importar en vivo: docs/demo/padron-de-ejemplo.csv (cuenta padre del barrio nuevo: ${cuentaDeDemostracion(60)}).

  Circuito de la deuda (ADR-0009):
${casos.noCobrar.map((c) => `    · «No cobrar interés» al imputar: ${c.barrio}, $ ${c.interes} condonados`).join("\n")}
${casos.condonacionParcial.map((c) => `    · Condonación parcial: ${c.barrio}, $ ${c.condonado} de $ ${c.devengado} de interés pendiente`).join("\n")}

  Encargo 11:
${casos.dosPartes.map((c) => `    · «No cobrar el interés» en dos partes: ${c.barrio}, ${c.unidad} — $ ${c.delPago} de este atraso y $ ${c.anterior} anterior (un operador no lo anula)`).join("\n")}
    · «Mes del servicio»: ${aromos.def.nombre}, la orden de la reparación del tablero (en la orden, Gastos, la boleta y el informe del mes emitido)

  T2, el circuito del mes (Liquidación actual):
    · Preparando: Barrio Demo Los Aromos — bloquea ${casos.altaSinCoeficiente ?? "una unidad nueva"} sin coeficiente; avisan el gasto extraordinario sin respaldo y las órdenes sin aprobar
    · Listo para emitir: Barrio Demo Las Cortaderas
    · Emitido con el envío pendiente: Barrio Demo Los Talas y Barrio Demo El Algarrobal
    · Aumento de cuota cargado: ${casos.aumento ? `${casos.aumento.barrio}, + 8 % desde ${casos.aumento.desde}` : "—"}
  Encargo 15 (vencimientos y padrón):
    · Barrio Demo Los Talas: segundo vencimiento a 3 días y corte a 10 días del último (Configuración y la boleta)
    · Barrio Demo Los Talas: una de cada 4 unidades con número de acción (LT-0001…) y una de cada 9 con residente`);
} catch (error) {
  await cliente.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
  await cliente.end();
}
