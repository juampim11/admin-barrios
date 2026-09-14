/**
 * El **productor** de `VistaInformeMensual`: de las filas del período al modelo de vista que la
 * plantilla imprime.
 *
 * Es la pieza que faltaba. La plantilla, el esquema y sus invariantes existían desde antes; nadie
 * los llenaba, y por eso `documento_emitido` no tiene una sola fila de `informe_mensual`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ SALE CON DATOS REALES Y QUÉ SALE COMO HUECO DECLARADO
 *
 * **Decisión de alcance del usuario (2026-08-28), y conviene tenerla presente leyendo este archivo
 * porque explica la mitad de su forma:** el modelo **no tiene caja, banco ni fondo de reserva con
 * saldos** — verificado: no existe ninguna tabla de movimientos de fondos, y el fondo de reserva
 * vive solo como *flags* (`concepto.es_fondo_reserva`, `barrio.tiene_fondo_reserva`), nunca como
 * saldo. Modelar eso es un módulo propio, del porte de Cobros o Proveedores/OP, y queda **fuera de
 * esta tanda**.
 *
 * Entonces:
 *
 * | Sección | De dónde sale |
 * |---|---|
 * | Barrio, figura **vigente en el período**, denominación | `barrio` + `barrio_atributo_vigencia` + `periodo_expensa` |
 * | Egresos, con `naturaleza` y `respaldo` | `gasto_periodo` ⨝ `concepto` ⨝ `documento_barrio` |
 * | Ingresos por rubro | subtotales de `liquidacion` |
 * | Resultado total y **ordinario** | derivados de los dos anteriores |
 * | Denominadores obligatorios | padrón activo, y gasto ÷ unidades |
 * | Deuda con proveedores | `orden_pago` por estado |
 * | **Fondos (banco/caja)** | **hueco declarado** — no existe el modelo |
 * | **Fondo de reserva** | **`null`** — no existe el modelo de saldos |
 * | **Conciliación (el puente)** | **huecos declarados** — depende de los fondos |
 * | Series históricas | `null` (hueco F-7, ya previsto por el esquema) |
 * | Créditos con las unidades | `null` salvo que el barrio habilite la sección |
 *
 * **Nada de esto se aproxima ni se infiere.** Un saldo bancario deducido de los pagos registrados
 * sería un número plausible y falso, y este documento existe para lo contrario. El `DatoFaltante`
 * dice qué falta y quién lo carga; ver el docstring de `faltantes.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL RESPALDO DE LAS EXTRAORDINARIAS TIENE FUENTE REAL, Y ESO NO ERA OBVIO
 *
 * El campo `naturaleza` + `respaldo` que se agregó al esquema por el art. 2048 no quedó teórico:
 * `concepto.tipo` ya distingue `ordinaria` de `extraordinaria`, y `gasto_periodo.acta_documento_id`
 * apunta al acta que la respalda, con `sin_respaldo_asamblea` marcando el caso en que se cargó sin
 * ella. O sea que el piso legal se cumple con lo que la base **ya sabe** — no hizo falta pedirle un
 * dato nuevo a nadie.
 */

import { sql } from "drizzle-orm";
import {
  cifra,
  faltante,
  fechaImpresa,
  participacion,
  VERSION_VISTA_INFORME,
  CLAVE_HONORARIOS_ADMINISTRACION,
  CLAVE_UNIDADES_ALCANZADAS,
  CLAVE_GASTO_POR_UNIDAD,
  parsearVistaInformeMensual,
  type GrupoImporte,
  type LineaDesagregada,
  type VistaInformeMensual,
} from "@admin-barrios/shared/documentos";
import { deCentavos, aCentavos, formatearDecimal } from "@admin-barrios/shared/dinero";
import { consultaPeriodoSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";
import { ROLES_QUE_EMITEN } from "./roles.ts";

/**
 * Lo que el llamador aporta y la base no sabe: la identidad impresa del emisor.
 *
 * Misma forma que `OpcionesVistaBoleta` y por el mismo motivo — el emisor **no puede caer a un valor
 * por defecto**, así que viaja explícito.
 */
export type OpcionesVistaInforme = {
  readonly marca: VistaInformeMensual["marca"];
  /** La fecha de corte del informe. No se deduce del período: la declara quien emite. */
  readonly corteIso: string;
  /** Cuándo se emite. `null` mientras no se emitió. */
  readonly emisionIso: string | null;
  /** Hasta cuándo y por dónde se reciben observaciones. `null` = el barrio no abre canal. */
  readonly recepcion?: { readonly plazoHastaIso: string; readonly canal: string } | null;
};

type FilaPeriodo = {
  periodo: string;
  estado: string;
  denominacion_concepto: string | null;
  puede_emitir: boolean;
  barrio_id: string;
  barrio_nombre: string;
  figura_juridica: string;
  domicilio: string | null;
  unidades_activas: number;
};

type FilaGasto = {
  concepto_clave: string;
  concepto_nombre: string;
  concepto_tipo: string;
  es_fondo_reserva: boolean;
  descripcion: string;
  monto: string;
  proveedor_nombre: string | null;
  acta_titulo: string | null;
  acta_fecha: string | null;
  sin_respaldo_asamblea: boolean;
};

/**
 * Arma la vista del informe mensual de un período.
 *
 * **Exige el mismo rol que emitir la boleta.** No es simetría: este documento publica el gasto del
 * barrio entero con sus proveedores, así que la RLS que dejó leer el período no alcanza —
 * `readable_tenant_ids()` incluye `contador` y `auditor`. Mismo gate que `armarVistasDelPeriodo()`.
 */
export async function armarVistaInformeMensual(
  tx: DbConIdentidad,
  periodoId: string,
  opciones: OpcionesVistaInforme,
): Promise<VistaInformeMensual> {
  const { periodoId: id } = consultaPeriodoSchema.parse({ periodoId });

  return enBase(async () => {
    const periodo = await leerPeriodoDelInforme(tx, id);
    if (!periodo.puede_emitir) {
      // `rechazar()` y no un `throw` pelado: `enBase` traduce cualquier error crudo a un mensaje
      // genérico —para no filtrar valores de filas— y este rechazo lo decide el servicio, así que
      // tiene que llegar entero a la pantalla. Mismo criterio que el resto de los servicios.
      rechazar(
        "sin_permiso",
        "No tenés permiso para emitir el informe de este barrio.",
        `Hace falta un rol de administración (${ROLES_QUE_EMITEN.join(", ")}).`,
      );
    }

    const gastos = await leerGastos(tx, id);
    const ingresos = await leerIngresos(tx, id, periodo.denominacion_concepto ?? "expensa");
    const egresos = agruparEgresos(gastos);

    /*
     * **Sin liquidaciones no hay informe, y falla acá con el motivo puesto.**
     *
     * El esquema exige al menos un grupo de ingreso, y tiene razón: un informe de un período que
     * todavía no se liquidó no puede decir en qué se repartió el gasto. La alternativa —publicar un
     * grupo de ingreso en cero— sería un documento que afirma que el barrio no recaudó nada, que es
     * falso y distinto de "todavía no se liquidó".
     */
    if (ingresos.length === 0) {
      rechazar(
        "periodo_incompleto",
        "El período todavía no tiene liquidaciones.",
        "El informe mensual se arma sobre el período liquidado: generá las liquidaciones primero.",
      );
    }

    const totalIngresos = sumar(ingresos.map((g) => g.importe.monto));
    const totalEgresos = sumar(egresos.map((g) => g.importe.monto));

    // Las participaciones se calculan DESPUÉS de conocer los totales: el invariante del esquema
    // exige que el número impreso salga del mismo denominador que el total impreso.
    const conParticipacion = (grupos: readonly GrupoImporte[], total: string): GrupoImporte[] =>
      grupos.map((g) => ({ ...g, participacionTexto: participacion(g.importe.monto, total) }));

    const ingresosFinales = conParticipacion(ingresos, totalIngresos);
    const egresosFinales = conParticipacion(egresos, totalEgresos);

    const soloOrdinarios = (grupos: readonly GrupoImporte[]) =>
      grupos.filter((g) => g.naturaleza === "ordinario").reduce((a, g) => a + aCentavos(g.importe.monto), 0n);

    const resultado = deCentavos(aCentavos(totalIngresos) - aCentavos(totalEgresos));
    const resultadoOrdinario = deCentavos(soloOrdinarios(ingresosFinales) - soloOrdinarios(egresosFinales));

    const deuda = await leerDeudaProveedores(tx, id, totalEgresos);

    const vista = {
      version: VERSION_VISTA_INFORME,
      marca: opciones.marca,
      barrio: {
        nombre: periodo.barrio_nombre,
        figuraJuridica: periodo.figura_juridica,
        domicilio: periodo.domicilio,
      },
      periodo: {
        codigo: periodo.periodo,
        etiqueta: etiquetaDePeriodo(periodo.periodo),
        corte: fechaImpresa(opciones.corteIso),
        denominacionConcepto: periodo.denominacion_concepto ?? "expensa",
      },
      emision: { fecha: opciones.emisionIso ? fechaImpresa(opciones.emisionIso) : null },
      devengado: {
        ingresos: ingresosFinales,
        egresos: egresosFinales,
        totalIngresos: cifra(totalIngresos),
        totalEgresos: cifra(totalEgresos),
        resultado: cifra(resultado),
        resultadoOrdinario: cifra(resultadoOrdinario),
      },
      conciliacion: conciliacionSinFuente(resultado),
      financiero: {
        fondos: fondosSinFuente(MARCADOR_SIN_FONDOS),
        deudaProveedores: deuda,
        // Ver el encabezado: no hay modelo de saldos del fondo. `null` significa "el barrio no
        // tiene fondo cargado" y es una respuesta legítima del esquema (art. 2046 inc. d, "si lo
        // hay") — no un hueco disfrazado.
        fondoReserva: null,
        // Apagada por default: este stock ES el total de mora agregado, y publicarlo es decisión
        // del barrio. Mientras no exista la configuración, no se enciende sola.
        creditosConUnidades: null,
      },
      denominadores: denominadores(periodo.unidades_activas, totalEgresos),
      /*
       * **La observación no es decorativa: el esquema la exige.** Un cuadro de fondos con un renglón
       * sin dato significa que el puente entre A y B no se pudo verificar, y el invariante rechaza
       * publicarlo *"como si el control hubiera corrido"*. Es la misma idea que el resto del
       * documento: lo que no cierra se dice en voz alta, en el renglón y al pie.
       */
      observaciones: [
        {
          clave: "no_concilia" as const,
          ancla: "financiero.fondos",
          marcador: MARCADOR_SIN_FONDOS,
          texto:
            "El sistema todavía no registra los movimientos de fondos del barrio, así que la " +
            "situación financiera y su conciliación con lo devengado no se pudieron verificar.",
        },
      ],
      recepcionDeObservaciones: opciones.recepcion
        ? { plazoHasta: fechaImpresa(opciones.recepcion.plazoHastaIso), canal: opciones.recepcion.canal }
        : null,
      notas: [],
      leyendas: [
        `Los importes de la sección A corresponden al período ${etiquetaDePeriodo(periodo.periodo)}.`,
      ],
      faltantes: [
        "situación financiera (movimientos de fondos): el sistema todavía no registra caja ni banco",
        "conciliación entre lo devengado y lo percibido: depende de los movimientos de fondos",
      ],
    };

    // Se parsea antes de devolver: los invariantes del esquema son parte del contrato de este
    // servicio, no una verificación que hace el llamador. Si algo no cierra, falla acá y no en el
    // worker, con el mensaje puesto.
    return parsearVistaInformeMensual(vista);
  });
}

// --- Lecturas -----------------------------------------------------------------------------------

async function leerPeriodoDelInforme(tx: DbConIdentidad, periodoId: string): Promise<FilaPeriodo> {
  const { rows } = await tx.execute<FilaPeriodo>(sql`
    select p.periodo, p.estado::text, p.denominacion_concepto,
           app.has_role_on(p.barrio_id, ${sql.raw(
             `array[${ROLES_QUE_EMITEN.map((r) => `'${r}'`).join(",")}]::app.rol_membership[]`,
           )}) as puede_emitir,
           b.barrio_id, n.nombre as barrio_nombre, b.domicilio_sede as domicilio,
           -- La figura VIGENTE EN EL PERÍODO, no la actual: los cinco ejes se versionan, y un barrio
           -- que se adecuó después no cambia retroactivamente el encuadre de un informe ya emitido.
           coalesce(
             (select v.valor from barrio_atributo_vigencia v
               where v.barrio_id = b.barrio_id and v.eje = 'figura_juridica'
                 and v.vigente_desde <= (p.periodo || '-01')::date
                 and (v.vigente_hasta is null or v.vigente_hasta >= (p.periodo || '-01')::date)
               order by v.vigente_desde desc limit 1),
             b.figura_juridica::text
           ) as figura_juridica,
           (select count(*) from unidad_funcional u
             where u.barrio_id = b.barrio_id and u.baja_at is null)::int as unidades_activas
      from periodo_expensa p
      join barrio b on b.barrio_id = p.barrio_id
      join tenant_node n on n.id = b.barrio_id
     where p.id = ${periodoId} and n.deleted_at is null
  `);

  const fila = rows[0];
  if (!fila) rechazarPeriodoInaccesible();
  return fila;
}

/**
 * Los gastos del período con todo lo que el informe necesita de cada uno: su concepto, si es
 * ordinario o extraordinario, y el acta que lo respalda cuando la hay.
 */
async function leerGastos(tx: DbConIdentidad, periodoId: string): Promise<FilaGasto[]> {
  const { rows } = await tx.execute<FilaGasto>(sql`
    select lower(regexp_replace(c.nombre, '[^a-zA-Z0-9]+', '_', 'g')) as concepto_clave,
           c.nombre as concepto_nombre, c.tipo::text as concepto_tipo, c.es_fondo_reserva,
           g.descripcion, g.monto::text, g.proveedor_nombre,
           d.titulo as acta_titulo, d.fecha_documento::text as acta_fecha,
           g.sin_respaldo_asamblea
      from gasto_periodo g
      join concepto c on c.id = g.concepto_id
      left join documento_barrio d on d.id = g.acta_documento_id
     where g.periodo_id = ${periodoId}
     order by c.tipo, c.nombre, g.descripcion
  `);
  return rows;
}

/**
 * Los ingresos del período, por rubro, desde los subtotales de las liquidaciones emitidas.
 *
 * **Es lo devengado, no lo cobrado** — que es lo correcto para la sección A. Lo percibido es la
 * sección B, que hoy no tiene fuente.
 */
async function leerIngresos(
  tx: DbConIdentidad,
  periodoId: string,
  denominacion: string,
): Promise<GrupoImporte[]> {
  const { rows } = await tx.execute<{
    ordinarias: string;
    extraordinarias: string;
    fondo_reserva: string;
    cargos: string;
    descuentos: string;
    cantidad: number;
  }>(sql`
    select coalesce(sum(subtotal_ordinarias), 0)::numeric(14,2)::text as ordinarias,
           coalesce(sum(subtotal_extraordinarias), 0)::numeric(14,2)::text as extraordinarias,
           coalesce(sum(subtotal_fondo_reserva), 0)::numeric(14,2)::text as fondo_reserva,
           coalesce(sum(subtotal_cargos), 0)::numeric(14,2)::text as cargos,
           coalesce(sum(subtotal_descuentos), 0)::numeric(14,2)::text as descuentos,
           count(*)::int as cantidad
      from liquidacion where periodo_id = ${periodoId}
  `);

  const f = rows[0];
  if (!f || f.cantidad === 0) return [];

  const grupos: GrupoImporte[] = [];
  const agregar = (
    clave: string,
    etiqueta: string,
    monto: string,
    naturaleza: "ordinario" | "extraordinario",
    desagregado: readonly LineaDesagregada[] = [],
  ) => {
    if (aCentavos(monto) === 0n) return;
    grupos.push({
      clave,
      etiqueta,
      naturaleza,
      respaldo: null,
      importe: cifra(monto),
      participacionTexto: "0,00",
      desagregado,
      lineasDeOrigen: f.cantidad,
    });
  };

  /*
   * La cuota ordinaria publica su NETO y lleva la bonificación adentro como línea desagregada — el
   * invariante del esquema rechaza un grupo negativo de primer nivel, porque dejaría el denominador
   * en neto y haría que los demás grupos impriman más de 100 %.
   */
  const netoOrdinario = deCentavos(aCentavos(f.ordinarias) + aCentavos(f.cargos) + aCentavos(f.descuentos));
  const desagregadoOrdinario: LineaDesagregada[] = [
    { concepto: `${capitalizar(denominacion)} del período`, proveedor: { tipo: "sin_identificar" }, importe: cifra(f.ordinarias) },
  ];
  if (aCentavos(f.cargos) !== 0n) {
    desagregadoOrdinario.push({ concepto: "Cargos de la unidad", proveedor: { tipo: "sin_identificar" }, importe: cifra(f.cargos) });
  }
  if (aCentavos(f.descuentos) !== 0n) {
    desagregadoOrdinario.push({ concepto: "Bonificaciones y descuentos", proveedor: { tipo: "sin_identificar" }, importe: cifra(f.descuentos) });
  }

  agregar(
    "cuota_ordinaria",
    `${capitalizar(denominacion)} del período`,
    netoOrdinario,
    "ordinario",
    desagregadoOrdinario.length > 1 ? desagregadoOrdinario : [],
  );
  agregar("fondo_reserva", "Fondo de reserva", f.fondo_reserva, "ordinario");

  /*
   * Las extraordinarias liquidadas **no llevan `respaldo` acá**: el respaldo vive en el gasto que
   * las originó (lado egreso), que es donde el art. 2048 lo ancla. Un mismo acta respaldando el
   * ingreso y el egreso se imprimiría dos veces y no diría nada nuevo.
   *
   * Por eso van como `ordinario` en la clasificación del grupo de INGRESO: lo que el discriminante
   * separa acá es el resultado ordinario del total, y lo cobrado por una extraordinaria financia
   * ese gasto extraordinario — contarlo como ordinario inflaría el resultado que dice si la cuota
   * alcanza. Se marca extraordinario y se le exige respaldo, con el del gasto.
   */
  if (aCentavos(f.extraordinarias) !== 0n) {
    grupos.push({
      clave: "contribucion_extraordinaria",
      etiqueta: "Contribuciones extraordinarias del período",
      naturaleza: "extraordinario",
      respaldo: faltante(
        "el respaldo de la extraordinaria se cita en el gasto que la originó, en la sección de egresos",
        null,
      ),
      importe: cifra(f.extraordinarias),
      participacionTexto: "0,00",
      desagregado: [],
      lineasDeOrigen: f.cantidad,
    });
  }

  return grupos;
}

async function leerDeudaProveedores(
  tx: DbConIdentidad,
  periodoId: string,
  devengado: string,
): Promise<VistaInformeMensual["financiero"]["deudaProveedores"]> {
  const { rows } = await tx.execute<{ pagado: string }>(sql`
    select coalesce(sum(monto), 0)::numeric(14,2)::text as pagado
      from orden_pago
     where periodo_id = ${periodoId} and estado in ('pagada', 'conciliada')
  `);

  return {
    // El saldo de apertura sale de la deuda acumulada, que hoy no se lleva: es parte del mismo
    // hueco que la sección B.
    saldoInicial: faltante("el sistema todavía no lleva el saldo acumulado con proveedores", "la administración"),
    devengadoDelPeriodo: cifra(devengado),
    pagadoEnElPeriodo: cifra(rows[0]?.pagado ?? "0.00"),
    saldoFinal: faltante("depende del saldo de apertura, que todavía no se lleva", "la administración"),
    cierreDelPeriodoAnterior: faltante("no hay informe anterior con el que comparar", "la administración"),
    marcadorObservacion: null,
  };
}

// --- Armado de los grupos de egreso -------------------------------------------------------------

/**
 * Agrupa los gastos por concepto y arma cada grupo con su naturaleza y su respaldo.
 *
 * **El respaldo se toma del acta del gasto**, que es donde el art. 2048 lo ancla. Cuando la
 * extraordinaria se cargó sin acta —`sin_respaldo_asamblea`, que pone un trigger y no la app— sale
 * un `DatoFaltante` que lo dice: el sistema no impide cargarla, pero el papel no la publica en
 * silencio.
 */
function agruparEgresos(gastos: readonly FilaGasto[]): GrupoImporte[] {
  const porConcepto = new Map<string, FilaGasto[]>();
  for (const g of gastos) {
    const actual = porConcepto.get(g.concepto_clave) ?? [];
    actual.push(g);
    porConcepto.set(g.concepto_clave, actual);
  }

  const grupos: GrupoImporte[] = [];
  for (const [clave, filas] of porConcepto) {
    const primera = filas[0]!;
    const total = sumar(filas.map((f) => f.monto));
    const extraordinario = primera.concepto_tipo === "extraordinaria";

    grupos.push({
      clave,
      etiqueta: primera.concepto_nombre,
      naturaleza: extraordinario ? "extraordinario" : "ordinario",
      respaldo: extraordinario ? respaldoDelGasto(filas) : null,
      importe: cifra(total),
      participacionTexto: "0,00",
      desagregado: filas.map((f) => ({
        concepto: f.descripcion,
        proveedor: proveedorDe(f.proveedor_nombre),
        importe: cifra(f.monto),
      })),
      lineasDeOrigen: filas.length,
    });
  }

  /*
   * El grupo de honorarios **tiene que existir siempre**, aunque valga cero: lo exige el esquema, y
   * el motivo está escrito ahí — diluirlo en otro rubro destruye la confianza. Si el barrio no
   * cargó ningún gasto de ese concepto, el renglón sale en cero y no ausente.
   */
  if (!grupos.some((g) => g.clave === CLAVE_HONORARIOS_ADMINISTRACION)) {
    grupos.push({
      clave: CLAVE_HONORARIOS_ADMINISTRACION,
      etiqueta: "Honorarios de administración",
      naturaleza: "ordinario",
      respaldo: null,
      importe: cifra("0.00"),
      participacionTexto: "0,00",
      desagregado: [],
      lineasDeOrigen: 1,
    });
  }

  return grupos;
}

/**
 * El acta que respalda una extraordinaria, o el hueco dicho en la cara.
 *
 * Con varios gastos del mismo concepto extraordinario se cita **la primera acta encontrada**: el
 * grupo es un renglón y no puede llevar dos referencias. El detalle por gasto vive en el segundo
 * nivel (doc 10 §D.2), que no se distribuye masivamente.
 */
function respaldoDelGasto(filas: readonly FilaGasto[]): GrupoImporte["respaldo"] {
  const conActa = filas.find((f) => f.acta_titulo !== null);
  if (conActa?.acta_titulo && conActa.acta_fecha) {
    return { tipo: "acta", referencia: conActa.acta_titulo, fecha: fechaImpresa(conActa.acta_fecha) };
  }
  /*
   * Un acta cargada **sin fecha** (`documento_barrio.fecha_documento` es nullable) no puede citarse
   * como respaldo: el esquema pide las tres puntas —tipo, referencia y fecha— porque una cita sin
   * fecha no permite ir a buscar el acto. Sale el hueco diciendo qué falta, que es más útil que una
   * referencia a medias.
   */
  if (conActa?.acta_titulo) {
    return faltante(`el acta "${conActa.acta_titulo}" está cargada sin fecha`, "la administración");
  }
  if (filas.some((f) => f.sin_respaldo_asamblea)) {
    return faltante("la extraordinaria se cargó sin acta de asamblea", "la administración");
  }
  return faltante("el acta que respalda esta erogación todavía no está cargada", "la administración");
}

/**
 * Cómo se nombra a quien cobró.
 *
 * **Sin nombre de persona.** Hoy `gasto_periodo.proveedor_nombre` es texto libre y el sistema no
 * sabe si es una razón social o una persona humana (doc 10 §D.4, hueco del modelo). Mientras no lo
 * sepa, este productor **no publica ningún nombre**: sale `sin_identificar` y el concepto del gasto
 * hace el trabajo. Publicar de más es irreversible; publicar de menos se corrige el día que el
 * modelo distinga las dos cosas.
 */
function proveedorDe(_nombre: string | null): LineaDesagregada["proveedor"] {
  return { tipo: "sin_identificar" };
}

// --- Las secciones sin fuente -------------------------------------------------------------------

/**
 * El marcador de la única observación que este productor emite. Es `1` porque es la única; si
 * mañana hay más, se numeran en orden y el `superRefine` verifica que cada marcador tenga su
 * observación.
 */
const MARCADOR_SIN_FONDOS = 1;

/**
 * Ver el encabezado: no hay modelo de caja ni banco. Nada de esto se aproxima.
 *
 * Lleva `marcadorObservacion` **obligatoriamente**: el esquema rechaza un cuadro con huecos que no
 * señale que el puente no se pudo verificar.
 */
function fondosSinFuente(marcador: number): VistaInformeMensual["financiero"]["fondos"] {
  const hueco = faltante("el sistema todavía no registra los movimientos de fondos", "la administración");
  return {
    saldoInicial: hueco,
    ingresos: hueco,
    egresos: hueco,
    saldoFinal: hueco,
    fuente: "Pendiente de carga",
    // `null` = no aplica, no cero. Sin modelo de fondo no hay nada que declarar afectado.
    afectadoAFondoReserva: null,
    marcadorObservacion: marcador,
  };
}

/**
 * El puente arranca en el resultado devengado —eso el esquema lo exige y sí lo sabemos— y no llega
 * a ningún lado, porque el otro extremo no existe. `diferenciaSinExplicar` en `null` sería declarar
 * que cierra; el renglón con hueco dice la verdad.
 */
function conciliacionSinFuente(resultado: string): VistaInformeMensual["conciliacion"] {
  /*
   * **El puente no explica nada, y eso se publica como tal.**
   *
   * `diferenciaSinExplicar` en `null` —o en cero— afirmaría que el puente cierra, y el invariante lo
   * rechaza con razón: *"un hueco no es un cero"*. Como el único renglón es un faltante, no suma, y
   * el residuo es **todo el resultado del período**. El documento dice exactamente eso: que no pudo
   * explicar nada del pasaje de lo devengado a lo percibido.
   */
  return {
    partida: cifra(resultado),
    renglones: [
      {
        etiqueta: "Movimientos de fondos del período",
        aclaracion: "El sistema todavía no registra caja ni banco: esta sección se completa cuando ese módulo exista.",
        importe: faltante("el sistema todavía no registra los movimientos de fondos", "la administración"),
        signo: "suma",
        marcadorObservacion: MARCADOR_SIN_FONDOS,
      },
    ],
    movimientoDeFondos: cifra("0.00"),
    diferenciaSinExplicar: cifra(deCentavos(-aCentavos(resultado))),
  };
}

// --- Denominadores ------------------------------------------------------------------------------

function denominadores(unidades: number, totalEgresos: string): VistaInformeMensual["denominadores"] {
  const porUnidad =
    unidades > 0 ? deCentavos(aCentavos(totalEgresos) / BigInt(unidades)) : null;

  return [
    {
      clave: CLAVE_UNIDADES_ALCANZADAS,
      etiqueta: "Unidades alcanzadas",
      valorTexto:
        unidades > 0
          ? formatearDecimal(String(unidades), 0)
          : faltante("el barrio todavía no tiene unidades activas cargadas", "la administración"),
      unidad: "unidades",
      comoSeCalcula: "Padrón del barrio a la fecha de corte, sin las unidades dadas de baja.",
      marcadorObservacion: null,
    },
    {
      clave: CLAVE_GASTO_POR_UNIDAD,
      etiqueta: "Gasto del período por unidad",
      valorTexto: porUnidad
        ? formatearDecimal(porUnidad, 2)
        : faltante("no se puede calcular sin unidades activas", "la administración"),
      unidad: null,
      comoSeCalcula: "Gasto total del período ÷ unidades alcanzadas.",
      marcadorObservacion: null,
    },
  ];
}

// --- Auxiliares ---------------------------------------------------------------------------------

function sumar(montos: readonly string[]): string {
  return deCentavos(montos.reduce<bigint>((a, m) => a + aCentavos(m), 0n));
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** `"2026-05"` → `"05/2026"`. Sin `Date`: una zona horaria no tiene nada que decir sobre un período. */
function etiquetaDePeriodo(periodo: string): string {
  const [anio, mes] = periodo.split("-");
  return `${mes}/${anio}`;
}
