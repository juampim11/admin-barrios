/**
 * Una `VistaBoleta` completa y coherente, para tests y para diseñar contra algo fijo.
 *
 * **Datos inventados, sin PII y sin nombres de clientes** (CLAUDE.md §1.5, ADR-0001 §1.1): barrio
 * genérico, `Mza 99` fuera del rango de cualquier padrón real, y un obligado que no existe. Los
 * números **cierran**: `gasto × coeficiente = importe` en cada línea y los dos totales cuadran, así
 * que sirve para verificar el dinero y para mostrar la hoja con una calculadora al lado.
 */

import { cifra, coeficienteImpreso, fechaImpresa, VERSION_VISTA_BOLETA, parsearVistaBoleta, type VistaBoleta } from "@admin-barrios/shared/documentos";
import { acentoImpreso } from "@admin-barrios/shared/documentos";
import { crearMedioGenericoDemo } from "../cobranza/adapters/generico-demo.ts";

const COEFICIENTE = "0.019074000";
const SUMA_DEL_JUEGO = "1.000000000";
const PERIODO = "2026-07";
const VENCIMIENTO = "2026-08-10";
const TOTAL = "358997.97";

const coef = () => coeficienteImpreso(COEFICIENTE, SUMA_DEL_JUEGO);

/** `gasto × coeficiente`, en las mismas cifras que imprimiría la hoja. */
function prorrateo(concepto: string, gasto: string, importe: string, extras: {
  clasificacion2048?: "ordinaria" | "extraordinaria" | "fondo_reserva";
  respaldo?: string;
  marcadorNota?: number;
} = {}) {
  return {
    concepto,
    clase: "prorrateo" as const,
    clasificacion2048: extras.clasificacion2048 ?? ("ordinaria" as const),
    gastoDelPeriodo: cifra(gasto),
    coeficiente: coef(),
    importe: cifra(importe),
    importeTeorico: cifra(importe),
    ajusteRedondeo: cifra("0.00"),
    respaldo: extras.respaldo ?? null,
    detalleHecho: null,
    marcadorNota: extras.marcadorNota ?? null,
  };
}

/** La boleta de muestra. `ajustes` permite derivar variantes sin duplicar el fixture entero. */
export function vistaBoletaDeMuestra(ajustes: Partial<VistaBoleta> = {}): VistaBoleta {
  const bloquePago = crearMedioGenericoDemo().armarBloquePago({
    barrio: "Barrio Demo Los Aromos",
    comprobante: "A-2026-07-00174",
    periodo: PERIODO,
    vencimiento: VENCIMIENTO,
    fechaTope: null,
    importe: TOTAL,
  });

  const base = {
    version: VERSION_VISTA_BOLETA,
    marca: {
      barrio: { nombre: "Barrio Demo Los Aromos", logo: null, acentoHex: acentoImpreso(null) },
      emisor: {
        razonSocial: "Estudio Demo — Administración",
        cuit: null,
        domicilio: null,
        contacto: null,
        logo: null,
      },
      pie: [],
    },
    barrio: {
      nombre: "Barrio Demo Los Aromos",
      figuraJuridica: "ph_especial" as const,
      domicilio: "Ruta E-53 km 12, Villa Allende, Córdoba",
    },
    unidad: { etiqueta: "Mza 99 · Lote 07", destinatario: "GÓMEZ, ANA" },
    periodo: {
      codigo: PERIODO,
      etiqueta: "07/2026",
      denominacionConcepto: "expensa",
      estado: "emitida" as const,
    },
    emision: { fecha: fechaImpresa("2026-07-31"), comprobante: "A-2026-07-00174" },
    bandas: [
      { clave: "al_dia" as const, marca: "ok" as const, titulo: "Al día", texto: "Esta boleta cubre solo el período 07/2026." },
      {
        clave: "bonificacion_aplicada" as const,
        marca: "estrella" as const,
        titulo: "Bonificación aplicada",
        texto: "-34.000,00 por pago en término.",
      },
    ],
    composicion: [
      { etiqueta: "Expensa ordinaria 07/2026", importe: cifra("326165.40"), informativo: false, aclaracion: null, marcadorNota: null },
      { etiqueta: "Aporte al fondo de reserva", importe: cifra("34333.20"), informativo: false, aclaracion: null, marcadorNota: null },
      { etiqueta: "Cuotas extraordinarias", importe: cifra("8499.37"), informativo: false, aclaracion: null, marcadorNota: 1 },
      {
        etiqueta: "Alquiler cancha de pádel",
        importe: cifra("24000.00"),
        informativo: false,
        aclaracion: "1 turno · 2026-07-12",
        marcadorNota: null,
      },
      {
        etiqueta: "Bonificación por pago en término",
        importe: cifra("-34000.00"),
        informativo: false,
        aclaracion: null,
        marcadorNota: 2,
      },
    ],
    totales: {
      delPeriodo: cifra(TOTAL),
      saldoAnterior: cifra("0.00"),
      interes: cifra("0.00"),
      aPagar: cifra(TOTAL),
    },
    interes: {
      base: cifra("0.00"),
      tasaMensualTexto: "3,0000",
      dias: 0,
      // Con interés en cero, la base exime del par (días, fecha de corte): la muestra refleja el
      // camino cotidiano, sin inventar una fecha que el sistema no tiene.
      computadoHasta: null,
    },
    detalle: {
      gastoDelBarrio: cifra("18900000.00"),
      coeficiente: coef(),
      lineas: [
        prorrateo("Vigilancia", "8100000.00", "154499.40"),
        prorrateo("Espacios verdes", "3400000.00", "64851.60"),
        prorrateo("Administración", "2200000.00", "41962.80"),
        prorrateo("Energía y alumbrado", "1900000.00", "36240.60"),
        prorrateo("Mantenimiento", "1500000.00", "28611.00"),
        prorrateo("Aporte fondo de reserva", "1800000.00", "34333.20", { clasificacion2048: "fondo_reserva" }),
        prorrateo("Portal de acceso", "445600.00", "8499.37", {
          clasificacion2048: "extraordinaria",
          respaldo: "Acta de Asamblea N.º 47 del 12/05/2026",
          marcadorNota: 1,
        }),
        {
          concepto: "Alquiler cancha de pádel",
          clase: "cargo" as const,
          clasificacion2048: "no_corresponde" as const,
          gastoDelPeriodo: null,
          coeficiente: null,
          importe: cifra("24000.00"),
          importeTeorico: null,
          ajusteRedondeo: cifra("0.00"),
          respaldo: null,
          detalleHecho: "1 turno · 2026-07-12",
          marcadorNota: null,
        },
        {
          concepto: "Bonificación por pago en término",
          clase: "descuento" as const,
          clasificacion2048: "no_corresponde" as const,
          gastoDelPeriodo: null,
          coeficiente: null,
          importe: cifra("-34000.00"),
          importeTeorico: null,
          ajusteRedondeo: cifra("0.00"),
          respaldo: null,
          detalleHecho: null,
          marcadorNota: 2,
        },
      ],
      continuaAlDorso: false,
    },
    bloquePago,
    notas: [
      { marcador: 1, texto: "Respaldo: Acta de Asamblea N.º 47 del 12/05/2026." },
      { marcador: 2, texto: "El importe ya está descontado del total del período." },
    ],
    leyendas: [
      "El pago de la presente no libera de obligaciones de períodos anteriores.",
      "El prorrateo usa el coeficiente con 9 decimales; acá se muestran 4.",
    ],
    faltantes: ["fecha tope de la red de cobranza — no existe como campo propio (doc 09 §E.11 ítem 1)"],
  };

  return parsearVistaBoleta({ ...base, ...ajustes });
}
