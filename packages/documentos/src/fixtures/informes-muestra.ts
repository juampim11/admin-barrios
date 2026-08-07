/**
 * Fixtures del informe mensual y del listado de saldos pendientes.
 *
 * **Todo es ficticio.** Ni un nombre, ni una unidad, ni un importe salen del material real: ese vive
 * fuera del repositorio, en `_referencias/`, y no puede entrar acá ni siquiera "para un test"
 * (CLAUDE.md §1.3). El barrio se llama Los Aromos, no existe, y los números están elegidos para que
 * las cuentas cierren a mano.
 *
 * Los constructores reciben un objeto de sustituciones para que cada test pueda **romper un solo
 * invariante por vez**: es la única forma de que un test que espera un error demuestre que el error
 * lo produce lo que el test dice y no otra cosa.
 */

import {
  cifra,
  faltante,
  fechaImpresa,
  participacion,
  VERSION_VISTA_INFORME,
  VERSION_VISTA_LISTADO_MORA,
  type GrupoImporte,
  type MarcaDocumento,
  type VistaInformeMensual,
  type VistaListadoMora,
} from "@admin-barrios/shared/documentos";

export const MARCA_MUESTRA_INFORME: MarcaDocumento = {
  barrio: { nombre: "Los Aromos", logo: null, acentoHex: "#3a4657" },
  emisor: {
    razonSocial: "Administración Los Aromos S.R.L.",
    cuit: "30112223334",
    domicilio: "Camino de las Sierras Km 4",
    contacto: "administracion@losaromos.test",
    logo: null,
  },
  pie: ["Consultas: administracion@losaromos.test"],
};

const TOTAL_INGRESOS = "9000000.00";
const TOTAL_EGRESOS = "7800000.00";

function grupo(
  clave: string,
  etiqueta: string,
  importe: string,
  total: string,
  desagregado: GrupoImporte["desagregado"],
  lineasDeOrigen: number,
): GrupoImporte {
  return {
    clave,
    etiqueta,
    importe: cifra(importe),
    participacionTexto: participacion(importe, total),
    desagregado,
    lineasDeOrigen,
  };
}

/** Un informe que cierra: los tests lo rompen de a un invariante. */
export function informeMuestra(cambios: Partial<VistaInformeMensual> = {}): unknown {
  return {
    version: VERSION_VISTA_INFORME,
    marca: MARCA_MUESTRA_INFORME,
    barrio: { nombre: "Los Aromos", figuraJuridica: "ph_especial", domicilio: "Camino de las Sierras Km 4" },
    periodo: {
      codigo: "2026-05",
      etiqueta: "05/2026",
      corte: fechaImpresa("2026-05-31"),
      denominacionConcepto: "expensa",
    },
    emision: { fecha: fechaImpresa("2026-07-10") },
    devengado: {
      ingresos: [
        // La bonificación va **adentro** de la cuota que deduce, no como grupo hermano: arriba
        // dejaría el denominador en neto y la cuota ordinaria imprimiría más de 100 %.
        grupo("cuota_ordinaria", "Cuota ordinaria del período", "9000000.00", TOTAL_INGRESOS, [
          { concepto: "Cuota ordinaria de lista", proveedor: { tipo: "sin_identificar" }, importe: cifra("10000000.00") },
          { concepto: "Bonificación por pago en término", proveedor: { tipo: "sin_identificar" }, importe: cifra("-1000000.00") },
        ], 2),
      ],
      egresos: [
        grupo("seguridad", "Seguridad y control de acceso", "5000000.00", TOTAL_EGRESOS, [
          { concepto: "Vigilancia contratada", proveedor: { tipo: "razon_social", nombre: "Vigía S.A." }, importe: cifra("4600000.00") },
          { concepto: "Mantenimiento de barreras", proveedor: { tipo: "sin_identificar" }, importe: cifra("400000.00") },
        ], 5),
        grupo("mantenimiento", "Mantenimiento e insumos", "2000000.00", TOTAL_EGRESOS, [
          { concepto: "Personal de mantenimiento", proveedor: { tipo: "persona_humana", cantidad: 2 }, importe: cifra("1500000.00") },
          { concepto: "Ferretería", proveedor: { tipo: "sin_identificar" }, importe: cifra("500000.00") },
        ], 9),
        grupo("honorarios_administracion", "Honorarios de administración", "500000.00", TOTAL_EGRESOS, [
          { concepto: "Honorarios de administración", proveedor: { tipo: "razon_social", nombre: "Administración Los Aromos S.R.L." }, importe: cifra("500000.00") },
        ], 1),
        grupo("servicios", "Servicios", "300000.00", TOTAL_EGRESOS, [], 3),
      ],
      totalIngresos: cifra(TOTAL_INGRESOS),
      totalEgresos: cifra(TOTAL_EGRESOS),
      resultado: cifra("1200000.00"),
    },
    conciliacion: {
      partida: cifra("1200000.00"),
      renglones: [
        {
          etiqueta: "Aumento de los créditos con las unidades",
          aclaracion: "lo que se devengó y todavía no se cobró",
          importe: cifra("500000.00"),
          signo: "resta",
          marcadorObservacion: null,
        },
        {
          etiqueta: "Aumento de la deuda con proveedores",
          aclaracion: null,
          importe: cifra("0.00"),
          signo: "suma",
          marcadorObservacion: null,
        },
      ],
      movimientoDeFondos: cifra("700000.00"),
      diferenciaSinExplicar: null,
    },
    financiero: {
      fondos: {
        saldoInicial: cifra("1000000.00"),
        ingresos: cifra("8500000.00"),
        egresos: cifra("7800000.00"),
        saldoFinal: cifra("1700000.00"),
        fuente: "Resumen de cuenta corriente bancaria",
        marcadorObservacion: null,
      },
      deudaProveedores: {
        saldoInicial: cifra("2000000.00"),
        devengadoDelPeriodo: cifra(TOTAL_EGRESOS),
        pagadoEnElPeriodo: cifra("7800000.00"),
        saldoFinal: cifra("2000000.00"),
        cierreDelPeriodoAnterior: cifra("2000000.00"),
        marcadorObservacion: null,
      },
    },
    denominadores: [
      {
        clave: "unidades",
        etiqueta: "Unidades alcanzadas",
        valorTexto: "40",
        unidad: "unidades",
        comoSeCalcula: "Padrón del barrio a la fecha de corte.",
        marcadorObservacion: null,
      },
      {
        clave: "fondo_reserva",
        etiqueta: "Fondo de reserva",
        valorTexto: faltante("el barrio todavía no carga el fondo de reserva", "la administración"),
        unidad: null,
        comoSeCalcula: "Aporte del período y saldo acumulado.",
        marcadorObservacion: null,
      },
    ],
    observaciones: [],
    notas: [],
    leyendas: ["Los importes de la sección A son del período 05/2026."],
    faltantes: ["fondo de reserva"],
    ...cambios,
  };
}

// --- Listado de saldos pendientes ---------------------------------------------------------------

const PENDIENTE_COMPOSICION = {
  capital: faltante("el sistema de origen no separa capital de intereses"),
  intereses: faltante("el sistema de origen no separa capital de intereses"),
  multas: faltante("el sistema de origen no separa las multas"),
  cargos: faltante("el sistema de origen no separa los cargos"),
};

/** Doce unidades: siete en gestión administrativa y cinco derivadas. Cumple k = 5 en las dos celdas. */
const SALDOS = [
  ["01 / 04", "PÉREZ, ANA", "gestion_administrativa", "900000.00"],
  ["02 / 11", "GÓMEZ, LUIS", "gestion_administrativa", "800000.00"],
  ["03 / 02", "SOSA, MARÍA", "gestion_administrativa", "700000.00"],
  ["04 / 07", "DÍAZ, JORGE", "gestion_administrativa", "600000.00"],
  ["05 / 19", "RUIZ, CLARA", "gestion_administrativa", "500000.00"],
  ["06 / 03", "MOLINA, PABLO", "gestion_administrativa", "400000.00"],
  ["07 / 15", "ACOSTA, ELENA", "gestion_administrativa", "300000.00"],
  ["08 / 21", "VERA, TOMÁS", "prejudicial", "2000000.00"],
  ["09 / 05", "LUNA, SOFÍA", "prejudicial", "1800000.00"],
  ["10 / 12", "BRITOS, HUGO", "prejudicial", "1600000.00"],
  ["11 / 08", "NAVARRO, INÉS", "prejudicial", "1400000.00"],
  ["12 / 16", "CASTRO, JULIÁN", "prejudicial", "1200000.00"],
] as const;

/** Suma de `SALDOS`: 12.200.000,00. Múltiplo de 1.000, así que sirve para los dos modos. */
export const TOTAL_LISTADO_MUESTRA = "12200000.00";

export function filasMuestra(): unknown[] {
  return SALDOS.map(([unidad, titular, instancia, saldo]) => ({
    unidad,
    titular,
    saldo: { total: cifra(saldo), ...PENDIENTE_COMPOSICION },
    antiguedad: faltante("el sistema de origen no informa desde qué período está impago el saldo"),
    instancia: { clave: instancia, derivadaEl: faltante("el sistema de origen no informa la fecha de derivación") },
    ultimaGestion: faltante("no hay registro de gestiones"),
    proximaAccion: faltante("no hay registro de gestiones"),
    variacion: null,
  }));
}

export const POLITICA_MUESTRA = {
  modo: "nominado" as const,
  destinatarios: "directorio" as const,
  pisoImporte: cifra("15000.00"),
  excluirPlanAlDia: true,
  kAnonimato: 5,
  redondeoAgregado: 1000,
};

function resumenMuestra(total: string) {
  return {
    total: cifra(total),
    unidades: SALDOS.length,
    evolucion: faltante("no hay un corte anterior con el que comparar"),
    tramos: [faltante("el sistema de origen no informa la antigüedad de cada saldo")],
    porInstancia: [
      {
        etiqueta: "Gestión administrativa",
        unidades: 7,
        importe: cifra("4200000.00"),
        fusionada: false,
      },
      {
        etiqueta: "Derivado a estudio jurídico",
        unidades: 5,
        importe: cifra("8000000.00"),
        fusionada: false,
      },
    ],
    concentracion: {
      unidades: 5,
      importe: cifra("8000000.00"),
      participacionTexto: participacion("8000000.00", total),
    },
  };
}

export function listadoNominadoMuestra(cambios: Record<string, unknown> = {}): unknown {
  return {
    version: VERSION_VISTA_LISTADO_MORA,
    marca: MARCA_MUESTRA_INFORME,
    barrio: { nombre: "Los Aromos", figuraJuridica: "ph_especial", domicilio: "Camino de las Sierras Km 4" },
    corte: fechaImpresa("2026-05-31"),
    emision: { fecha: fechaImpresa("2026-06-05") },
    politica: POLITICA_MUESTRA,
    resumen: resumenMuestra(TOTAL_LISTADO_MUESTRA),
    detalle: {
      modo: "nominado",
      filas: filasMuestra(),
      respaldoDecision: { tipo: "acta", referencia: "Acta de directorio N.º 12", fecha: fechaImpresa("2025-11-20") },
      copia: "AB12-3",
    },
    notas: [],
    leyendas: ["Los saldos están medidos a la fecha de corte."],
    faltantes: ["composición del saldo"],
    ...cambios,
  };
}

export function listadoAgregadoMuestra(cambios: Record<string, unknown> = {}): unknown {
  return {
    version: VERSION_VISTA_LISTADO_MORA,
    marca: MARCA_MUESTRA_INFORME,
    barrio: { nombre: "Los Aromos", figuraJuridica: "ph_especial", domicilio: "Camino de las Sierras Km 4" },
    corte: fechaImpresa("2026-05-31"),
    emision: { fecha: fechaImpresa("2026-06-05") },
    politica: { ...POLITICA_MUESTRA, modo: "agregado" as const },
    resumen: resumenMuestra(TOTAL_LISTADO_MUESTRA),
    detalle: { modo: "agregado" },
    notas: [],
    leyendas: ["Versión agregada."],
    faltantes: [],
    ...cambios,
  };
}

export type { VistaInformeMensual, VistaListadoMora };
