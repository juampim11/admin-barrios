/**
 * La plantilla del **informe mensual del barrio**: `VistaInformeMensual` → HTML.
 *
 * Es el documento que viaja con la boleta y contesta lo que la boleta individual no puede: *"¿en qué
 * se gastó la plata de todos?"*. Misma familia gráfica que la boleta —mismos tokens, misma marca en
 * dos niveles, misma jerarquía—, otro formato: A4 multipágina, sin instrumento de pago, sin troquel.
 *
 * Reglas que este archivo no puede romper, heredadas de la boleta:
 *
 *  - **No formatea dinero ni fechas.** Todo llega resuelto en la vista; acá sólo se imprime `.texto`.
 *  - **No emite ninguna URL externa.** La red está apagada en el renderizador.
 *  - **No inventa tamaños ni tintas.** Salen de `@admin-barrios/design-tokens`.
 *
 * Y tres propias, que son las que arreglan los defectos del documento que reemplaza (doc 10 §B.1):
 *
 *  - **El resultado del período va arriba de todo lo que lo explica**, con sus dos operandos pegados.
 *    Nadie tiene que llegar al pie de la página 2 para saber cómo cerró el mes.
 *  - **Las secciones se rotulan con letra y las letras se usan.** El informe actual define `(A)`,
 *    `(B)`… y no las referencia en ningún lado, así que el lector busca un vínculo que no existe.
 *  - **El período y el corte van en 18 pt en el encabezado, y en el encabezado corrido de cada
 *    página.** Este informe cierra dos meses antes que la boleta con la que viaja.
 */

import { fontSizePrint as fp, printInk as tinta, printPatron } from "@admin-barrios/design-tokens";
import { esFaltante, type VistaInformeMensual } from "@admin-barrios/shared/documentos";
import type { GrupoImporte, Observacion } from "@admin-barrios/shared/documentos";
import {
  cabeceraDeIdentidad,
  celdaCifra,
  cierreDelDocumento,
  ETIQUETA_FIGURA,
  franjaDeAcento,
  encabezadoCorrido,
  escapar,
  estilosFamilia,
  hojaConCorridos,
  pieCorrido,
  recuentoPendientes,
  type FuenteEmbebida,
} from "./comun.ts";
import {
  ANCHO_COLUMNA_BARRAS_MM,
  celdaBarra,
  estilosGraficos,
  llevaColumnaDeBarras,
  tiraDePeriodos,
} from "./graficos.ts";
import { glifoBanda, glifoDireccion } from "./glifos.ts";

/** Rótulo impreso del documento. Aparece en el encabezado corrido de todas las páginas. */
export const NOMBRE_INFORME = "Informe mensual del barrio";

/** CSS del informe. Se emite una sola vez por lote, igual que el de la boleta. */
export function estilosInformeMensual(fuentes: readonly FuenteEmbebida[] = []): string {
  return [
    estilosFamilia(fuentes),
    estilosGraficos(),
    // (`.zona-p` vive en `estilosFamilia`: es la capa "sin zoom" de los dos multipágina.)
    // --- La ecuación del resultado -------------------------------------------------------------
    ".ecuacion{width:100%;border-collapse:collapse;margin-top:1mm}",
    `.ecuacion td{padding:.3mm 0;font-size:${fp.base}pt;vertical-align:baseline}`,
    ".ecuacion td.imp{text-align:right;width:42mm;white-space:nowrap}",
    // --- La cifra y su historia, lado a lado ---------------------------------------------------
    // La tira se paga con el blanco que ya había a la derecha (doc 10 §I.6): **cero milímetros de
    // alto nuevos**, que es la condición que §I.1 le pone a cualquier forma para entrar.
    //
    // Y es una **tabla de layout fijo**, no un `flex`, por la misma razón que la hoja: con el layout
    // automático la celda se ensancha para acomodar a su contenido —una tabla de renglones pide su
    // ancho mínimo y no cede— y el bloque entero se sale del papel por la derecha. La guarda de
    // desbordes del renderizador lo atrapó antes de que saliera un PDF; esto es el arreglo.
    // `break-inside:avoid`: la tira y el bloque que ilustra no se separan. Sin esto, un salto de
    // página puede dejar la tira arriba y el renglón de cierre del que es la historia en la hoja
    // siguiente — que es peor que no tener tira.
    ".par{width:100%;table-layout:fixed;border-collapse:collapse;break-inside:avoid;page-break-inside:avoid}",
    ".par > tbody > tr > td{padding:0;vertical-align:bottom}",
    ".par > tbody > tr > td.con-tira{padding-left:6mm;width:34mm}",
    // --- Tabla de grupos -----------------------------------------------------------------------
    ".tabla .grupo-nombre{font-weight:600}",
    `.tabla .desagregado td{border-bottom:none;padding:.15mm 0;font-size:${fp.xs}pt;color:${tinta.textSecondary}}`,
    ".tabla .desagregado td:first-child{padding-left:6mm}",
    `.tabla .cierra-grupo td{border-bottom:.4pt solid ${tinta.hairline}}`,
    // --- Denominadores: cajas ------------------------------------------------------------------
    // `inline-block` y no `flex`: un contenedor flex sólo se parte **entre líneas** y Chromium empuja
    // el resto entero a la página siguiente, dejando un hueco de seis centímetros en el medio del
    // informe. Con cajas en línea el corte lo decide el flujo normal y el hueco desaparece.
    ".denominadores{margin-top:1.5mm;font-size:0}",
    `.denom{display:inline-block;vertical-align:top;width:calc(25% - 1.5mm);margin:0 2mm 2mm 0;border:.4pt solid ${tinta.hairline};padding:1.4mm 2mm;break-inside:avoid}`,
    ".denom:nth-child(4n){margin-right:0}",
    `.denom .et{font-size:${fp.xs}pt;color:${tinta.textSecondary};text-transform:uppercase;letter-spacing:.04em;line-height:1.2}`,
    `.denom .v{font-size:${fp.lg}pt;font-weight:700;line-height:1.25;margin-top:.4mm}`,
    // Un valor largo se parte en dos renglones antes que empujar la caja: `.cifra` trae
    // `white-space:nowrap` porque en una tabla de dinero eso es lo correcto, y acá no.
    ".denom .v .cifra{white-space:normal;overflow-wrap:anywhere}",
    `.denom .v .unidad{font-weight:400;font-size:${fp.base}pt}`,
    `.denom .como{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2;margin-top:.4mm}`,
    // --- Observaciones -------------------------------------------------------------------------
    `.observaciones{margin-top:4mm;border-top:${printPatron.conclusionFilete}pt solid ${tinta.textPrimary};padding-top:1.5mm;break-inside:avoid}`,
    `.observaciones .t{font-size:${fp.base}pt;font-weight:600;text-transform:uppercase;letter-spacing:.04em}`,
    `.observaciones div.o{font-size:${fp.xs}pt;color:${tinta.textPrimary};line-height:1.3;margin-top:.8mm;display:flex;gap:2mm;align-items:flex-start}`,
    ".observaciones .glifo{margin-top:.3mm}",
  ].join("");
}

// --- Piezas -------------------------------------------------------------------------------------

function filaGrupo(g: GrupoImporte, ultimaDelBloque: boolean, total: string | null): string {
  const sub = g.desagregado
    .map((l) => {
      // El proveedor persona humana NO tiene dónde poner el nombre: el tipo lleva una cantidad
      // (doc 10 §D.4). Acá sólo se decide cómo se lee esa cantidad.
      const quien =
        l.proveedor.tipo === "razon_social"
          ? escapar(l.proveedor.nombre)
          : l.proveedor.tipo === "persona_humana"
            ? `${l.proveedor.cantidad} ${l.proveedor.cantidad === 1 ? "persona" : "personas"}`
            : null;
      return (
        '<tr class="desagregado">' +
        `<td>${escapar(l.concepto)}${quien === null ? "" : ` <span>(${quien})</span>`}</td>` +
        '<td class="num"></td>' +
        (total === null ? "" : "<td></td>") +
        `<td class="num cifra">${escapar(l.importe.texto)}</td>` +
        "</tr>"
      );
    })
    .join("");

  const cierre = ultimaDelBloque || g.desagregado.length > 0 ? " cierra-grupo" : "";
  return (
    `<tr class="${cierre.trim()}">` +
    `<td class="grupo-nombre">${escapar(g.etiqueta)}` +
    (g.lineasDeOrigen > 1 && g.desagregado.length === 0
      ? ` <span style="font-weight:400;color:${tinta.textSecondary}">(${g.lineasDeOrigen} gastos)</span>`
      : "") +
    "</td>" +
    `<td class="num cifra">${escapar(g.participacionTexto)} %</td>` +
    // **G-1.** La barra sale del mismo texto que se imprime dos celdas más allá, y se escala de 0 al
    // total del cuadro: la pista siempre es el 100 %, así que las filas de todos los cuadros de todos
    // los meses se comparan entre sí (doc 10 §I.5.6). La barra **no** sale de la participación ya
    // calculada: `participacionTexto` es un porcentaje del total, y dibujarlo contra una pista que
    // también significa el total sería medir dos veces la misma división.
    (total === null ? "" : `<td class="g-celda">${celdaBarra(g.importe.texto, total)}</td>`) +
    `<td class="num cifra">${escapar(g.importe.texto)}</td>` +
    "</tr>" +
    sub
  );
}

/**
 * Un cuadro de grupos, con o sin la columna de barras.
 *
 * `barras` no lo decide quien llama por gusto: lo decide `llevaColumnaDeBarras()` sobre los importes
 * publicados, y **para el cuadro entero**. Un cuadro con un renglón negativo no es una partición de un
 * todo, y uno con menos de tres renglones se lee mejor sin dibujo (doc 10 §I.7, casos 4 y 6).
 */
function tablaDeGrupos(titulo: string, grupos: readonly GrupoImporte[], total: string, barras: boolean): string {
  const escala = barras ? total : null;
  return [
    '<table class="tabla">',
    "<colgroup><col><col style=\"width:20mm\">" +
      (barras ? `<col style="width:${ANCHO_COLUMNA_BARRAS_MM}mm">` : "") +
      '<col style="width:34mm"></colgroup>',
    `<thead><tr><th>${escapar(titulo)}</th><th class="num">% del total</th>` +
      // La columna de barras **no lleva encabezado**: no hay escala que rotular ni eje que nombrar
      // (§I.5.4), y un título sobre una columna sin números invita a medirla con la regla.
      (barras ? "<th></th>" : "") +
      '<th class="num">Importe</th></tr></thead>',
    "<tbody>",
    grupos.map((g, i) => filaGrupo(g, i === grupos.length - 1, escala)).join(""),
    "</tbody>",
    '<tfoot><tr><td>Total</td><td class="num cifra">100,00 %</td>' +
      (barras ? "<td></td>" : "") +
      `<td class="num cifra">${escapar(total)}</td></tr></tfoot>`,
    "</table>",
  ].join("");
}

/**
 * El resultado del período: la cifra que el informe de hoy nunca calcula.
 *
 * Cinco recursos la vuelven la más importante de la hoja, y **ninguno es "más grande que el resto"**:
 * los dos operandos impresos pegados formando la ecuación completa, el filete de conclusión, el aire
 * alrededor, la posición por encima de todo lo que la explica, y el denominador en la línea
 * siguiente. 24 pt y no 32: 32 es de la única cifra del producto que alguien paga.
 *
 * **Sin color, ni en superávit ni en déficit.** En los tokens del producto el rojo es mora; un
 * déficit no es una mora ni un error del sistema —un barrio puede tener déficit planificado contra el
 * fondo— y pintarlo de rojo hace que la administración pida sacarlo del informe. En negro se queda.
 * La dirección la da el triángulo, la valencia la da la palabra.
 */
function titularResultado(v: VistaInformeMensual): string {
  const positivo = !v.devengado.resultado.monto.startsWith("-");
  const rotulo = positivo ? "Superávit del período" : "Déficit del período";
  const signo = positivo ? "+" : "";
  const denominadores = v.denominadores
    .filter((d) => d.clave === "resultado_por_unidad" || d.clave === "resultado_sobre_ingresos")
    .map((d) => `${escapar(d.etiqueta)}: ${esFaltante(d.valorTexto) ? "pendiente" : escapar(d.valorTexto)}`)
    .join(" · ");

  return [
    '<section class="titular-doc" data-desborde="resultado">',
    '<table class="ecuacion">',
    `<tr><td>Ingresos devengados ${escapar(v.periodo.etiqueta)}</td><td class="imp cifra">$ ${escapar(v.devengado.totalIngresos.texto)}</td></tr>`,
    `<tr><td>− Egresos devengados ${escapar(v.periodo.etiqueta)}</td><td class="imp cifra">$ ${escapar(v.devengado.totalEgresos.texto)}</td></tr>`,
    "</table>",
    `<div class="et" style="border-top:${printPatron.conclusionFilete}pt solid ${tinta.textPrimary};padding-top:1.2mm;margin-top:.8mm">${escapar(rotulo)}</div>`,
    // **G-2.** *"¿este superávit es lo normal o es raro?"* — la cuenta que reemplaza es abrir los
    // informes de los meses anteriores. Va pegada al número, sin rótulo: el rótulo es el renglón de
    // arriba y el valor del último punto es el número de al lado, en 24 pt.
    parConTira(
      [
        '<div class="monto cifra">',
        glifoDireccion(positivo ? "sube" : "baja"),
        `<span>${signo} $ ${escapar(v.devengado.resultado.texto)}</span>`,
        "</div>",
        denominadores === "" ? "" : `<div class="denominador">${denominadores}</div>`,
      ].join(""),
      tiraDePeriodos(v.series.resultado, { rotulo: null }),
    ),
    "</section>",
  ].join("");
}

/**
 * Un bloque y su tira, uno al lado del otro. Sin tira, el bloque queda **exactamente como estaba**:
 * la tabla de un solo `td` no cambia una coma del ancho ni del alto.
 */
function parConTira(contenido: string, tira: string): string {
  if (tira === "") return contenido;
  return (
    '<table class="par"><tbody><tr>' +
    `<td>${contenido}</td>` +
    `<td class="con-tira">${tira}</td>` +
    "</tr></tbody></table>"
  );
}

function seccionA(v: VistaInformeMensual): string {
  // **G-1 vive en el cuadro de gastos y sólo ahí.** En el de ingresos no entra, y no por una regla de
  // cupo: la pregunta que la forma 1 contesta —*"¿en qué se va la plata?"*— es del gasto, y el cuadro
  // de ingresos tiene cuatro renglones que se comparan leyéndolos. Es el descarte 6 de doc 10 §I.4.
  const barras = llevaColumnaDeBarras(v.devengado.egresos.map((g) => g.importe.texto));
  return [
    '<section class="seccion" data-desborde="seccion-a">',
    '<div class="rotulo">A · Resultado del período — criterio devengado</div>',
    '<div class="definicion">Devengado: lo que corresponde al período, se haya cobrado o pagado o no. Es la sección que contesta «¿en qué se gastó?».</div>',
    tablaDeGrupos("Ingresos del período", v.devengado.ingresos, v.devengado.totalIngresos.texto, false),
    '<div style="height:3mm"></div>',
    tablaDeGrupos("Gastos del período", v.devengado.egresos, v.devengado.totalEgresos.texto, barras),
    "</section>",
  ].join("");
}

function seccionB(v: VistaInformeMensual): string {
  const f = v.financiero.fondos;
  const d = v.financiero.deudaProveedores;
  const marca = (m: number | null) => (m === null ? "" : ` (${m})`);
  const renglon = (etiqueta: string, valor: Parameters<typeof celdaCifra>[0], marcador: number | null) =>
    `<tr><td><span class="lin"><span>${escapar(etiqueta)}${marca(marcador)}</span><span class="guia"></span></span></td>` +
    `<td class="imp">${celdaCifra(valor, null)}</td></tr>`;

  return [
    '<section class="seccion" data-desborde="seccion-b">',
    '<div class="rotulo">B · Situación financiera — criterio percibido</div>',
    '<div class="definicion">Percibido: la plata que efectivamente entró y salió en el período, sea de este período o de otros. Hay <strong>un solo</strong> cuadro de fondos: el informe anterior imprimía dos idénticos.</div>',
    '<table class="renglones">',
    renglon(`Fondos al inicio del período — ${f.fuente}`, f.saldoInicial, f.marcadorObservacion),
    renglon("+ Ingresos acreditados en el período", f.ingresos, null),
    renglon("− Pagos y débitos del período", f.egresos, null),
    '<tr class="subtotal"><td><span class="lin"><span>Fondos al cierre del período</span><span class="guia"></span></span></td>' +
      `<td class="imp">${celdaCifra(f.saldoFinal, null)}</td></tr>`,
    "</table>",
    '<div style="height:3mm"></div>',
    '<div class="definicion">Rueda de la deuda con proveedores. El saldo con el que abre tiene que ser el que cerró el informe anterior.</div>',
    // **G-3.** *"¿la deuda con proveedores se está estabilizando o se está yendo?"* La tabla de la
    // rueda se angosta 34 mm y la guía de puntos absorbe la diferencia: no baja un renglón de lugar.
    parConTira(
      [
        '<table class="renglones">',
        renglon("Deuda con proveedores al inicio", d.saldoInicial, d.marcadorObservacion),
        renglon("+ Gastos devengados del período (sección A)", d.devengadoDelPeriodo, null),
        renglon("− Pagos a proveedores del período", d.pagadoEnElPeriodo, null),
        '<tr class="subtotal"><td><span class="lin"><span>Deuda con proveedores al cierre</span><span class="guia"></span></span></td>' +
          `<td class="imp">${celdaCifra(d.saldoFinal, null)}</td></tr>`,
        renglon("Cierre informado en el período anterior", d.cierreDelPeriodoAnterior, null),
        "</table>",
      ].join(""),
      tiraDePeriodos(v.series.deudaProveedores, { rotulo: null }),
    ),
    "</section>",
  ].join("");
}

/**
 * La escalera que pasa de A a B.
 *
 * Es lo que el informe de hoy no tiene: dice cuánto se gastó y cuánto entró, y nada explica cómo se
 * pasa de una cifra a la otra — así que ninguna de las dos se puede verificar (doc 10 §B.1 hallazgo 4).
 *
 * El renglón de cierre se imprime **siempre**, valga cero o no. Un lector que ve `$ 0,00` ahí sabe
 * que el control corrió; un renglón ausente no dice nada. Y no existe el renglón "Otros" ni "Ajustes
 * varios": es el mecanismo exacto por el que una cifra que no concilia desaparece de un informe.
 */
function seccionC(v: VistaInformeMensual): string {
  const c = v.conciliacion;
  const pendientes = c.renglones.filter((r) => esFaltante(r.importe)).length;
  const dif = c.diferenciaSinExplicar;
  const rotuloCierre =
    dif === null ? "Sin diferencias" : pendientes > 0 ? "Diferencia no explicada por el puente" : "Diferencia sin explicar";

  return [
    '<section class="seccion" data-desborde="seccion-c">',
    '<div class="rotulo">C · Cómo se pasa de A a B</div>',
    '<div class="definicion">Cada renglón de esta escalera es una diferencia entre los dos criterios: lo devengado que todavía no se cobró o no se pagó.</div>',
    '<table class="renglones">',
    `<tr><td><span class="lin"><span>Resultado del período (A)</span><span class="guia"></span></span></td><td class="imp cifra">$ ${escapar(c.partida.texto)}</td></tr>`,
    ...c.renglones.map((r) => {
      const signo = r.signo === "suma" ? "+" : "−";
      return (
        '<tr><td><span class="lin"><span>' +
        `${signo} ${escapar(r.etiqueta)}${r.marcadorObservacion === null ? "" : ` (${r.marcadorObservacion})`}` +
        // La aclaración va DEBAJO y no al costado: al costado empujaba la etiqueta a dos renglones y
        // el ojo dejaba de encontrar el comienzo de cada paso de la escalera.
        (r.aclaracion ? `<br><span class="aclara">${escapar(r.aclaracion)}</span>` : "") +
        '</span><span class="guia"></span></span></td>' +
        `<td class="imp">${celdaCifra(r.importe, r.marcadorObservacion)}</td></tr>`
      );
    }),
    '<tr class="subtotal"><td><span class="lin"><span>Movimiento de fondos del período (B)</span><span class="guia"></span></span></td>' +
      `<td class="imp cifra">$ ${escapar(c.movimientoDeFondos.texto)}</td></tr>`,
    '<tr class="conclusion"><td><span class="lin"><span>' +
      (dif === null ? "" : glifoBanda("atencion")) +
      `${escapar(rotuloCierre)}</span><span class="guia"></span></span></td>` +
      `<td class="imp cifra">$ ${escapar(dif === null ? "0,00" : dif.texto)}</td></tr>`,
    "</table>",
    recuentoPendientes(pendientes, c.renglones.length),
    "</section>",
  ].join("");
}

function seccionDenominadores(v: VistaInformeMensual): string {
  if (v.denominadores.length === 0) return "";
  return [
    '<section class="seccion" data-desborde="denominadores">',
    '<div class="rotulo">D · Los denominadores</div>',
    '<div class="definicion">Sin denominador, un total de millones no significa nada. Cada caja dice cómo se calcula para que se pueda rehacer.</div>',
    '<div class="denominadores">',
    ...v.denominadores.map((d) =>
      [
        '<div class="denom">',
        `<div class="et">${escapar(d.etiqueta)}</div>`,
        '<div class="v">',
        esFaltante(d.valorTexto)
          ? `<span class="pendiente">pendiente${d.marcadorObservacion === null ? "" : ` (${d.marcadorObservacion})`}</span>`
          : `<span class="cifra">${escapar(d.valorTexto)}</span>` +
            (d.unidad === null ? "" : `<span class="unidad"> ${escapar(d.unidad)}</span>`),
        "</div>",
        // **Acá vivía G-4, la tira de la cobranza del período, y se sacó con el documento ya impreso
        // delante** (doc 10 §I.4, descarte 9). Con la serie real del barrio piloto —101,92 % a
        // 94,05 %— y el eje obligado a arrancar en cero, las cuatro columnas salían del mismo alto:
        // una forma que no discrimina ocupa lugar y no informa. Recortar el eje para que la
        // diferencia se viera está prohibido (§I.5.6) y es justamente lo que la haría mentir.
        `<div class="como">${escapar(d.comoSeCalcula)}</div>`,
        "</div>",
      ].join(""),
    ),
    "</div>",
    "</section>",
  ].join("");
}

function seccionObservaciones(observaciones: readonly Observacion[]): string {
  if (observaciones.length === 0) return "";
  return [
    '<section class="observaciones" data-desborde="observaciones">',
    '<div class="t">Lo que no se pudo verificar</div>',
    ...observaciones.map(
      (o) => `<div class="o">${glifoBanda("atencion")}<span>(${o.marcador}) ${escapar(o.texto)}</span></div>`,
    ),
    "</section>",
  ].join("");
}

/** Fragmento HTML de **un** informe. Es lo que se concatena si algún día se emite en lote. */
export function cuerpoInformeMensual(v: VistaInformeMensual): string {
  const corrido = encabezadoCorrido({
    barrio: v.marca.barrio.nombre,
    documento: NOMBRE_INFORME,
    periodo: `Período ${v.periodo.etiqueta}`,
    corte: v.periodo.corte.texto,
    criterio: "Secciones A y C: devengado · Sección B: percibido",
    emitido: v.emision.fecha?.texto ?? null,
    // Una hoja 4 suelta necesita el aviso de desfasaje tanto como la primera.
    advertencias: [`Informe de ${v.periodo.etiqueta}, no del período de la boleta que lo acompaña`],
  });

  const pie = pieCorrido(`${v.marca.barrio.nombre} · ${NOMBRE_INFORME} · Corte ${v.periodo.corte.texto}`);

  const contenido = [
    // La columna derecha del bloque de identidad lleva **dato del barrio**, no del documento: la
    // fecha de emisión (y su ausencia) viven en el encabezado corrido, que es donde se leen en todas
    // las páginas y no sólo en la primera.
    cabeceraDeIdentidad(v.marca, [
      escapar(ETIQUETA_FIGURA[v.barrio.figuraJuridica] ?? v.barrio.figuraJuridica),
      v.barrio.domicilio ? escapar(v.barrio.domicilio) : "",
    ]),
    // Zona P: la respuesta antes que la pregunta.
    '<section class="zona-p" data-desborde="periodo-corte">',
    `<div><div class="et">Período del informe</div><div class="v cifra">${escapar(v.periodo.etiqueta)}</div></div>`,
    `<div><div class="et">Fecha de corte</div><div class="v cifra">${escapar(v.periodo.corte.texto)}</div></div>`,
    "</section>",
    '<div style="height:2.5mm"></div>',
    '<div class="banda">',
    glifoBanda("info"),
    '<span><span class="t">Este informe no es del período de la boleta.</span> ',
    `<span class="d">Corresponde a ${escapar(v.periodo.etiqueta)} y cierra al ${escapar(v.periodo.corte.texto)}: se arma cuando están el extracto del banco y las facturas del período.</span></span>`,
    "</div>",
    titularResultado(v),
    seccionA(v),
    seccionB(v),
    seccionC(v),
    seccionDenominadores(v),
    seccionObservaciones(v.observaciones),
    // Huecos declarados + notas + leyendas + pie del emisor, cada uno con su propia condición. La
    // versión anterior condicionaba todo el bloque a que hubiera leyendas y se llevaba puesto el pie.
    cierreDelDocumento(v),
  ].join("");

  // La franja va FUERA de la tabla: es absoluta y sangra sobre el margen superior de la página 1.
  return `<article class="doc">${franjaDeAcento(v.marca)}${hojaConCorridos(corrido, pie, contenido)}</article>`;
}
