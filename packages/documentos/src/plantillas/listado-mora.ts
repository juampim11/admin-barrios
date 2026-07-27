/**
 * La plantilla del **listado de saldos pendientes**: `VistaListadoMora` → HTML.
 *
 * Documento propio, con su propia lista de distribución: **nunca dentro del mismo envío que la boleta
 * individual de una unidad** (doc 10 §E.3 — la boleta la recibe también el inquilino, que paga las
 * expensas pero no es el obligado).
 *
 * La plantilla **no decide** qué se publica: recibe `detalle`, que es una unión discriminada, y pinta
 * la rama que le tocó. En la rama agregada no hay filas que imprimir porque el tipo no las tiene.
 *
 * Tres decisiones de composición que vienen del uso real y no de la estética:
 *
 *  1. **Se agrupa por instancia de gestión y se ordena para trabajar.** El listado de hoy va por
 *     importe descendente: pone arriba los casos que ya están en el estudio jurídico —sobre los que
 *     la administración no va a hacer nada esta semana— y hunde al final los frescos, que todavía se
 *     recuperan con un llamado. Como la instancia **es** la sección donde estás parado, además se
 *     ahorra la columna que la repetiría en cada fila.
 *  2. **La composición del saldo va en columnas y no se saca nunca**, aunque hoy llegue vacía. Es la
 *     promesa del producto y la condición para poder recortar el saldo puro más adelante; que hoy
 *     esté pendiente es exactamente lo que el documento tiene que dejar a la vista. Las columnas
 *     accesorias sí se caen cuando les falta más de la mitad de los datos.
 *  3. **Nada de texto libre por fila.** La última gestión y la próxima acción salen de un vocabulario
 *     cerrado: una columna de observaciones es donde alguien escribe "no atiende el teléfono", queda
 *     congelada para siempre y sale impresa en un papel que circula.
 */

import { fontSizePrint as fp, printFila, printInk as tinta, printPatron } from "@admin-barrios/design-tokens";
import {
  cifra,
  esFaltante,
  faltante,
  ORDEN_DE_TRABAJO,
  TITULO_LISTADO_MORA,
  type CeldaAgregada,
  type CifraOFaltante,
  type FilaMora,
  type InstanciaGestion,
  type VistaListadoMora,
} from "@admin-barrios/shared/documentos";
import { aCentavos, deCentavos } from "@admin-barrios/shared/dinero";
import {
  ANCHO_UTIL_ARCHIVO_MM,
  cabeceraDeIdentidad,
  celdaCifra,
  cierreDelDocumento,
  franjaDeAcento,
  encabezadoCorrido,
  escapar,
  estilosFamilia,
  hojaConCorridos,
  pieCorrido,
  type FuenteEmbebida,
} from "./comun.ts";
import { glifoBanda, glifoDireccion } from "./glifos.ts";

/** Rótulos impresos. Ninguno califica a una persona (doc 07 §E, grupo G). */
export const ETIQUETA_INSTANCIA: Record<InstanciaGestion, string> = {
  vencido: "Vencido, sin gestión iniciada",
  gestion_administrativa: "Gestión administrativa",
  aviso_formal: "Aviso formal con constancia",
  prejudicial: "Derivado a estudio jurídico",
  judicial: "Con reclamo judicial iniciado",
};

export const ETIQUETA_TRAMO: Record<string, string> = {
  un_periodo: "1 período",
  dos_periodos: "2 períodos",
  de_3_a_6: "3 a 6 períodos",
  de_7_a_12: "7 a 12 períodos",
  mas_de_12: "más de 12 períodos",
};

export const ETIQUETA_ACCION: Record<string, string> = {
  sin_gestion_registrada: "sin gestión registrada",
  aviso_por_correo: "aviso por correo",
  llamado: "llamado",
  nota_impresa: "nota impresa",
  reunion: "reunión",
  acuerdo_de_pago: "acuerdo de pago",
  derivacion: "derivación",
};

export function estilosListadoMora(fuentes: readonly FuenteEmbebida[] = []): string {
  return [
    estilosFamilia(fuentes),
    // --- Cabecera del listado (`.zona-p` vive en `estilosFamilia`) -----------------------------
    `.evolucion{display:flex;align-items:center;gap:2mm;font-size:${fp.base}pt;margin-top:.8mm}`,
    // --- Cuadro de antigüedad ------------------------------------------------------------------
    // Una sola barra sólida y el porcentaje impreso al lado: la barra es redundante por diseño. Una
    // rampa de cuatro grises son dos grises después de una fotocopia.
    ".barra{display:inline-block;height:1.8mm;background:" + tinta.textSecondary + ";vertical-align:middle}",
    ".tabla td.barra-celda{width:24mm;padding-left:3mm}",
    // --- Encabezado de grupo, en dos piezas ----------------------------------------------------
    // El título **fuerte** se imprime una sola vez, fuera de la tabla; adentro del `thead` va un eco
    // liviano que Chromium repite en cada página. Ver `tablaNominada()` para el porqué.
    //
    // Filete izquierdo y no barra rellena: una barra rellena con texto calado, fotocopiada, es un
    // ladrillo negro con un fantasma adentro.
    ".titulo-grupo{margin-top:4.5mm;break-after:avoid;page-break-after:avoid}",
    `.titulo-grupo .banda{font-size:${fp.base}pt}`,
    ".tabla.mora tr.eco-grupo th{border-bottom:none;padding:1.4mm 0 .6mm;text-transform:none;letter-spacing:0;font-weight:400}",
    // --- Filas ---------------------------------------------------------------------------------
    `.tabla.mora td{padding:.6mm 0;line-height:1.2;min-height:${printFila.simple}mm}`,
    // El `padding-right` va también en el `th`: la clase de la celda no la hereda el encabezado, y
    // "MZA / LOTE" terminaba pegado a "TITULAR" como si fueran una sola columna.
    '.tabla.mora .unidad,.tabla.mora th:first-child{white-space:nowrap;padding-right:3mm}',
    ".tabla.mora .titular{padding-right:3mm}",
    ".tabla.mora .saldo{font-weight:600}",
    // La celda que abarca las cuatro columnas de composición se centra sobre ellas: alineada a la
    // derecha quedaba pegada al saldo, como si fuera su etiqueta.
    ".tabla.mora td.composicion-pendiente{text-align:center}",
    // Una fila y su segunda línea son **un solo cuerpo de tabla**: así el salto de página nunca deja
    // "Subió $X contra el corte anterior" arriba de todo, huérfano de la fila que lo explica.
    ".tabla.mora tbody{break-inside:avoid;page-break-inside:avoid}",
    // --- Modo agregado -------------------------------------------------------------------------
    `.aviso-modo{margin-top:4mm;border:.4pt solid ${tinta.hairline};border-left-width:1.2mm;padding:1.5mm 2.5mm;font-size:${fp.base}pt}`,
    `.politica{font-size:${fp.xs}pt;color:${tinta.textSecondary};margin-top:2mm;line-height:1.3}`,
    `.copia{font-size:${fp.xs}pt;color:${tinta.textSecondary}}`,
    `.alcance{margin-top:2.5mm;border-top:${printPatron.conclusionFilete}pt solid ${tinta.textPrimary};border-bottom:${printPatron.conclusionFilete}pt solid ${tinta.textPrimary};padding:1.2mm 0;font-size:${fp.base}pt;font-weight:600;display:flex;gap:2mm;align-items:center}`,
  ].join("");
}

// --- Columnas -----------------------------------------------------------------------------------

type Columna = {
  readonly clave: string;
  readonly titulo: string;
  readonly mm: number;
  readonly numerica: boolean;
  /**
   * `true` = la columna **es la promesa del producto** y no se cae aunque llegue vacía. Es el caso de
   * la composición del saldo: que hoy esté pendiente es justamente lo que hay que dejar a la vista.
   * `false` = accesoria; si le falta más de la mitad de los datos, se saca y se declara una vez.
   */
  readonly estructural: boolean;
  readonly valor: (f: FilaMora) => string;
  readonly faltante: (f: FilaMora) => boolean;
};

const COLUMNAS: readonly Columna[] = [
  {
    clave: "unidad",
    titulo: "Mza / Lote",
    mm: 18,
    numerica: false,
    estructural: true,
    valor: (f) => `<span class="cifra">${escapar(f.unidad)}</span>`,
    faltante: () => false,
  },
  {
    clave: "titular",
    titulo: "Titular",
    mm: 35,
    numerica: false,
    estructural: true,
    // Envuelve a dos renglones; **nunca se trunca**: un nombre cortado identifica mal a una persona.
    valor: (f) => escapar(f.titular),
    faltante: () => false,
  },
  {
    clave: "antiguedad",
    titulo: "Antigüedad",
    mm: 15,
    numerica: false,
    estructural: false,
    valor: (f) => (esFaltante(f.antiguedad) ? "" : escapar(ETIQUETA_TRAMO[f.antiguedad] ?? f.antiguedad)),
    faltante: (f) => esFaltante(f.antiguedad),
  },
  {
    clave: "capital",
    titulo: "Capital",
    mm: 24,
    numerica: true,
    estructural: true,
    valor: (f) => celdaCifra(f.saldo.capital, null),
    faltante: (f) => esFaltante(f.saldo.capital),
  },
  {
    clave: "intereses",
    titulo: "Intereses",
    mm: 21,
    numerica: true,
    estructural: true,
    valor: (f) => celdaCifra(f.saldo.intereses, null),
    faltante: (f) => esFaltante(f.saldo.intereses),
  },
  {
    // **Multas y cargos comparten columna, y no es una concesión estética: no entran.** A 9 pt
    // monoespaciada un importe de siete cifras mide ~24 mm, así que las cuatro columnas de
    // composición más el saldo se llevan 109 de los 178 mm útiles y al titular le quedan 19 — un
    // nombre truncado, que es lo único que este documento no puede hacer. Se desagregan en la
    // segunda línea de la fila, que es donde se leen de a una.
    clave: "otros",
    titulo: "Otros cargos",
    mm: 20,
    numerica: true,
    estructural: true,
    valor: (f) => celdaCifra(otrosCargos(f), null),
    faltante: (f) => esFaltante(otrosCargos(f)),
  },
  {
    clave: "saldo",
    titulo: "Saldo al corte",
    mm: 25,
    numerica: true,
    estructural: true,
    valor: (f) => `<span class="cifra saldo">${escapar(f.saldo.total.texto)}</span>`,
    faltante: () => false,
  },
  {
    clave: "proxima",
    titulo: "Próxima acción",
    mm: 20,
    numerica: false,
    estructural: false,
    valor: (f) => (esFaltante(f.proximaAccion) ? "" : `<span class="cifra">${escapar(f.proximaAccion.fechaPrevista.texto)}</span>`),
    faltante: (f) => esFaltante(f.proximaAccion),
  },
];

/**
 * Qué columnas se imprimen.
 *
 * Regla de escalado del patrón de dato pendiente: **celdas sueltas se marcan; una columna a la que le
 * falta más de la mitad de los datos no se imprime vacía — no se imprime**, y una nota lo declara una
 * vez. Cuarenta filas de trama a 45° no informan nada y arruinan la hoja.
 *
 * Las columnas `estructural` quedan siempre, con su trama y su nota: son la promesa del producto.
 */
export function columnasDelListado(filas: readonly FilaMora[]): {
  columnas: readonly Columna[];
  omitidas: readonly string[];
} {
  const omitidas: string[] = [];
  const columnas = COLUMNAS.filter((c) => {
    if (c.estructural || filas.length === 0) return true;
    const sinDato = filas.filter((f) => c.faltante(f)).length;
    if (sinDato * 2 > filas.length) {
      omitidas.push(c.titulo);
      return false;
    }
    return true;
  });
  return { columnas, omitidas };
}

/**
 * Reparte el ancho útil entre las columnas que quedaron: lo que libera una omitida va al titular.
 *
 * **Falla si el presupuesto no entra.** Antes, la resta se le cargaba al titular sin mirar el signo:
 * con las columnas accesorias presentes el titular quedaba en 9 mm y los nombres se aplastaban, y la
 * guarda de desbordes del renderizador no lo veía —un nombre que envuelve no produce desborde de
 * ancho—. Un presupuesto que no cierra es un error de diseño, no algo que se acomoda en tiempo de
 * render.
 */
function anchos(columnas: readonly Columna[]): Map<string, number> {
  const usados = columnas.reduce((a, c) => a + c.mm, 0);
  const sobra = ANCHO_UTIL_ARCHIVO_MM - usados;
  if (sobra < 0) {
    throw new Error(
      `las columnas del listado piden ${usados} mm y la hoja tiene ${ANCHO_UTIL_ARCHIVO_MM}: ` +
        "no se emite un listado con el nombre del titular aplastado",
    );
  }
  const mapa = new Map(columnas.map((c) => [c.clave, c.mm]));
  mapa.set("titular", (mapa.get("titular") ?? 0) + sobra);
  return mapa;
}

// --- Piezas -------------------------------------------------------------------------------------

/** Las claves de las columnas de composición del saldo, tal como se imprimen. */
const COMPOSICION: readonly string[] = ["capital", "intereses", "otros"];

/**
 * Multas + cargos, o el hueco.
 *
 * **Mixto cuenta como hueco**: publicar la suma con una de las dos partes sin cargar daría un número
 * completo hecho de un dato y una ausencia, que es peor que decir que falta.
 */
function otrosCargos(f: FilaMora): CifraOFaltante {
  const { multas, cargos } = f.saldo;
  if (esFaltante(multas) || esFaltante(cargos)) {
    return faltante(
      esFaltante(multas) && esFaltante(cargos)
        ? "el sistema de origen no separa las multas ni los cargos del saldo"
        : "falta una de las dos partes de «otros cargos», y una suma a medias no se publica",
    );
  }
  return cifra(deCentavos(aCentavos(multas.monto) + aCentavos(cargos.monto)));
}

/**
 * Las celdas de una fila.
 *
 * **Cuando faltan las cuatro columnas de composición, se imprime una sola celda que las abarca**, no
 * cuatro veces la misma palabra sobre la misma trama. Es la diferencia entre un documento que declara
 * un hueco y una hoja que parece rota: con cuarenta filas, cuatro tramas por fila son ciento sesenta
 * manchas y el ojo deja de encontrar el saldo, que es lo único que ahí sí está.
 */
function celdasDeFila(f: FilaMora, columnas: readonly Columna[]): string {
  const composicion = columnas.filter((c) => COMPOSICION.includes(c.clave));
  const todaFalta = composicion.length > 0 && composicion.every((c) => c.faltante(f));

  const celdas: string[] = [];
  let yaFusionada = false;
  for (const c of columnas) {
    if (todaFalta && COMPOSICION.includes(c.clave)) {
      if (yaFusionada) continue;
      yaFusionada = true;
      celdas.push(
        `<td class="num composicion-pendiente" colspan="${composicion.length}">` +
          '<span class="pendiente">pendiente</span></td>',
      );
      continue;
    }
    // El `&& c.estructural` que había acá dejaba la celda de una columna accesoria **en blanco**
    // cuando faltaba el dato: el renglón ausente que `faltantes.ts` enumera como una de las tres
    // formas de mentir. Se marca igual; la columna entera se cae recién cuando falta en más de la
    // mitad de las filas.
    celdas.push(
      `<td class="${c.numerica ? "num" : ""} ${c.clave}">` +
        (c.faltante(f) ? '<span class="pendiente">pendiente</span>' : c.valor(f)) +
        "</td>",
    );
  }
  return celdas.join("");
}

function segundaLinea(f: FilaMora, colspan: number): string {
  const partes = [
    // Multas y cargos comparten columna: acá se leen de a uno, que es para lo que sirve esta línea.
    esFaltante(f.saldo.multas) || esFaltante(f.saldo.cargos)
      ? null
      : `Multas ${f.saldo.multas.texto} · Cargos ${f.saldo.cargos.texto}`,
    esFaltante(f.ultimaGestion)
      ? null
      : `Últ. gestión ${f.ultimaGestion.fecha.texto} · ${ETIQUETA_ACCION[f.ultimaGestion.accion] ?? f.ultimaGestion.accion}`,
    esFaltante(f.proximaAccion)
      ? null
      : `Próxima: ${ETIQUETA_ACCION[f.proximaAccion.accion] ?? f.proximaAccion.accion}`,
    esFaltante(f.instancia.derivadaEl) ? null : `Derivada el ${f.instancia.derivadaEl.texto}`,
    f.variacion === null
      ? null
      : f.variacion.clase === "nueva"
        ? "Nueva en el listado"
        : f.variacion.clase === "sin_cambio"
          ? "Sin cambios contra el corte anterior"
          : `${f.variacion.clase === "aumento" ? "Subió" : "Bajó"} ${f.variacion.importe.texto} contra el corte anterior`,
  ].filter((x): x is string => x !== null);
  if (partes.length === 0) return "";
  return `<tr><td class="sub" colspan="${colspan}">${escapar(partes.join(" · "))}</td></tr>`;
}

function tablaNominada(v: VistaListadoMora & { detalle: { modo: "nominado" } }): string {
  const filas = v.detalle.filas;
  const { columnas, omitidas } = columnasDelListado(filas);
  const ancho = anchos(columnas);

  /**
   * El grupo se anuncia en **dos piezas de peso distinto**, y esa es toda la diferencia entre la
   * primera aparición y la repetición.
   *
   * El problema real: el rótulo tiene que vivir dentro del `thead` para que Chromium lo repita —sin
   * eso, una hoja 6 suelta muestra cuarenta apellidos sin decir en qué instancia de gestión están—,
   * pero repetido **a peso pleno** cada página abre con lo que parece una sección nueva, y el lector
   * arranca de cero seis veces. Y el CSS no puede distinguir la primera aparición de las siguientes:
   * un `thead` repetido se estila igual en todas.
   *
   * La salida no es restilar la repetición sino **agregar algo que exista una sola vez**: el título
   * pleno (banda con glifo, filete y versalitas) va fuera de la tabla y se imprime una vez; adentro
   * del `thead` queda un eco de una línea, en la tinta secundaria. En la página 1 el lector ve título
   * + epígrafe; en la 5 ve sólo el epígrafe, y eso ya se lee como "seguís en el mismo grupo".
   *
   * **Por qué no un "(continúa)":** el texto del `thead` es el mismo en todas las páginas, así que la
   * palabra sería falsa en la primera aparición. Este documento no imprime algo falso para ganar
   * prolijidad. La señal de continuidad es que el título dejó de aparecer.
   *
   * El eco **conserva las cifras del grupo** (unidades y saldo): son el subtotal, y una hoja suelta
   * sin eso deja una columna de dinero sin su total — que es la regla dura del proyecto.
   */
  const resumenDelGrupo = (instancia: InstanciaGestion, unidades: number, importe: string | null) =>
    `${unidades} ${unidades === 1 ? "unidad" : "unidades"}${importe === null ? "" : ` · $ ${escapar(importe)}`}`;

  const tituloDelGrupo = (instancia: InstanciaGestion, unidades: number, importe: string | null) =>
    '<div class="titulo-grupo"><div class="banda">' +
    glifoBanda(instancia === "prejudicial" || instancia === "judicial" ? "atencion" : "info") +
    `<span><span class="t">${escapar(ETIQUETA_INSTANCIA[instancia])}</span> ` +
    `<span class="d">${resumenDelGrupo(instancia, unidades, importe)}</span></span></div></div>`;

  const encabezado = (instancia: InstanciaGestion, unidades: number, importe: string | null) =>
    "<colgroup>" +
    columnas.map((c) => `<col style="width:${ancho.get(c.clave)}mm">`).join("") +
    "</colgroup>" +
    "<thead>" +
    `<tr class="eco-grupo"><th colspan="${columnas.length}">` +
    `${escapar(ETIQUETA_INSTANCIA[instancia])} · ${resumenDelGrupo(instancia, unidades, importe)}` +
    "</th></tr>" +
    "<tr>" +
    columnas.map((c) => `<th class="${c.numerica ? "num" : ""}">${escapar(c.titulo)}</th>`).join("") +
    "</tr></thead>";

  // Agrupado por instancia, en orden de trabajo: las etapas recuperables primero, las terminales al
  // final y en modo lectura.
  const bloques = ORDEN_DE_TRABAJO.map((instancia) => {
    const delGrupo = filas.filter((f) => f.instancia.clave === instancia);
    if (delGrupo.length === 0) return "";
    const total = v.resumen.porInstancia.find((c) => c.etiqueta === ETIQUETA_INSTANCIA[instancia]);
    const cuerpo = delGrupo
      .map(
        (f, i) =>
          "<tbody>" +
          `<tr class="${(i + 1) % printPatron.filaGrupoCada === 0 ? "grupo" : ""}">` +
          celdasDeFila(f, columnas) +
          "</tr>" +
          segundaLinea(f, columnas.length) +
          "</tbody>",
      )
      .join("");

    return (
      tituloDelGrupo(instancia, delGrupo.length, total ? total.importe.texto : null) +
      `<table class="tabla mora" data-desborde="tabla-mora-${instancia}">` +
      encabezado(instancia, delGrupo.length, total ? total.importe.texto : null) +
      cuerpo +
      "</table>"
    );
  }).join("");

  const nota =
    omitidas.length === 0
      ? ""
      : `<div class="notas"><div>No se imprimen las columnas ${escapar(omitidas.join(", "))}: el sistema todavía no tiene ese dato para más de la mitad de las unidades del listado. Se incorporan en cuanto se carguen.</div></div>`;

  return bloques + nota;
}

function cuadroAgregado(titulo: string, celdas: readonly (CeldaAgregada | { faltante: true; motivo: string })[], total: string): string {
  const publicables = celdas.filter((c): c is CeldaAgregada => !esFaltante(c));
  // La barra mide el **importe**, no la cantidad de unidades. Con unidades, la instancia con menos
  // casos y más plata se dibujaba más corta que la de muchos casos chicos, que es al revés de lo que
  // la fila dice.
  const mayor = publicables.reduce((a, c) => (Number(c.importe.monto) > a ? Number(c.importe.monto) : a), 0);
  const pendientes = celdas.filter(esFaltante);
  return [
    `<table class="tabla" data-desborde="cuadro-${escapar(titulo)}">`,
    '<colgroup><col><col style="width:24mm"><col style="width:34mm"><col style="width:24mm"></colgroup>',
    `<thead><tr><th>${escapar(titulo)}</th><th class="num">Unidades</th><th class="num">Saldo</th><th></th></tr></thead>`,
    "<tbody>",
    ...publicables.map((c) => {
      const ancho = mayor === 0 ? 0 : (Number(c.importe.monto) / mayor) * 22;
      return (
        "<tr>" +
        `<td>${escapar(c.etiqueta)}${c.fusionada ? " <span>(agrupado)</span>" : ""}</td>` +
        `<td class="num cifra">${c.unidades}</td>` +
        `<td class="num cifra">${escapar(c.importe.texto)}</td>` +
        `<td class="barra-celda"><span class="barra" style="width:${ancho.toFixed(1)}mm"></span></td>` +
        "</tr>"
      );
    }),
    ...pendientes.map(
      (c) =>
        `<tr><td colspan="2">${escapar(c.motivo)}</td><td class="num"><span class="pendiente">pendiente</span></td><td></td></tr>`,
    ),
    "</tbody>",
    // Sin celdas publicables, el conteo del pie diría "0 unidades" al lado del total del documento:
    // un cero que afirma algo que nadie midió. Se imprime el guion de "no aplica".
    `<tfoot><tr><td>Total</td><td class="num ${publicables.length === 0 ? "" : "cifra"}">` +
      (publicables.length === 0 ? "—" : String(publicables.reduce((a, c) => a + c.unidades, 0))) +
      `</td><td class="num cifra">${escapar(total)}</td><td></td></tr></tfoot>`,
    "</table>",
  ].join("");
}

function cabeceraDelListado(v: VistaListadoMora): string {
  const e = v.resumen.evolucion;
  const evolucion = esFaltante(e)
    ? `<div class="evolucion"><span class="pendiente">${escapar(e.motivo)}</span></div>`
    : [
        '<div class="evolucion">',
        glifoDireccion(e.variacionImporte.monto.startsWith("-") ? "baja" : "sube"),
        `<span class="cifra">${escapar(e.variacionTexto)}</span>`,
        `<span>contra el corte del ${escapar(e.corteAnterior.texto)} (${escapar(e.totalAnterior.texto)}, ${e.unidadesAnterior} unidades)</span>`,
        "</div>",
      ].join("");

  return [
    '<section class="zona-p" data-desborde="corte">',
    `<div><div class="et">Saldos al</div><div class="v cifra">${escapar(v.corte.texto)}</div></div>`,
    "</section>",
    '<section class="titular-doc" data-desborde="total-mora">',
    '<div class="et">Total de saldos pendientes</div>',
    `<div class="monto cifra"><span>$ ${escapar(v.resumen.total.texto)}</span></div>`,
    `<div class="denominador">${v.resumen.unidades} ${v.resumen.unidades === 1 ? "unidad" : "unidades"} con saldo al corte</div>`,
    evolucion,
    "</section>",
  ].join("");
}

function alcanceYPolitica(v: VistaListadoMora): string {
  const p = v.politica;
  const partes = [
    p.modo === "nominado" ? "publicación nominada" : "versión agregada, sin datos de unidades individuales",
    `destinatarios: ${p.destinatarios.replace(/_/g, " ")}`,
    p.pisoImporte === null ? "sin piso de importe" : `no se publican saldos menores a $ ${p.pisoImporte.texto}`,
    p.excluirPlanAlDia ? "no se publica quien tiene convenio y lo está cumpliendo" : "incluye a quienes tienen convenio vigente",
    `agrupación mínima: ${p.kAnonimato} unidades`,
  ];
  const r = v.detalle.modo === "nominado" ? v.detalle.respaldoDecision : null;
  const respaldo =
    r === null
      ? ""
      : esFaltante(r)
        ? // El hueco de gobierno se dice en la cara, con el mismo patrón que cualquier otro dato que
          // falta. Un respaldo inventado para destrabar la emisión se lee igual que uno real.
          `<span class="pendiente">${escapar(r.motivo)}</span>`
        : `Publicación aprobada por ${escapar(r.tipo)} ${escapar(r.referencia)} del ${escapar(r.fecha.texto)}.`;

  return [
    '<div class="alcance">',
    glifoBanda(v.detalle.modo === "nominado" ? "atencion" : "info"),
    v.detalle.modo === "nominado"
      ? "<span>Documento de gestión interna del barrio. Incluye datos personales; su circulación está limitada a los destinatarios indicados.</span>"
      : "<span>Versión agregada: no contiene datos de unidades individuales.</span>",
    "</div>",
    `<div class="politica">Política aplicada: ${escapar(partes.join(" · "))}. ${respaldo}` +
      (v.detalle.modo === "nominado" ? ` <span class="copia">Copia ${escapar(v.detalle.copia)}.</span>` : "") +
      "</div>",
  ].join("");
}

/** Fragmento HTML de **un** listado. */
export function cuerpoListadoMora(v: VistaListadoMora): string {
  const corrido = encabezadoCorrido({
    barrio: v.marca.barrio.nombre,
    documento: TITULO_LISTADO_MORA,
    periodo: null,
    corte: v.corte.texto,
    criterio: "Saldos al corte",
    emitido: v.emision.fecha?.texto ?? null,
    advertencias:
      v.detalle.modo === "nominado"
        ? [`Uso interno · Copia ${v.detalle.copia}`]
        : ["Versión agregada · sin datos de unidades individuales"],
  });

  const pie = pieCorrido(`${v.marca.barrio.nombre} · ${TITULO_LISTADO_MORA} · Corte ${v.corte.texto}`);

  const contenido = [
    // Sólo dato del barrio: la fecha de emisión vive en el encabezado corrido (ver `informe-mensual`).
    cabeceraDeIdentidad(v.marca, [v.barrio.domicilio ? escapar(v.barrio.domicilio) : ""]),
    cabeceraDelListado(v),
    alcanceYPolitica(v),
    '<section class="seccion" data-desborde="antiguedad">',
    '<div class="rotulo">Antigüedad de la deuda</div>',
    '<div class="definicion">Los tramos se cuentan en <strong>períodos de expensa</strong>, no en días: la expensa vence una vez por mes, así que «90 días» es «3 cuotas» y decirlo en días obliga a hacer la división mentalmente.</div>',
    cuadroAgregado("Tramo", v.resumen.tramos, v.resumen.total.texto),
    "</section>",
    '<section class="seccion" data-desborde="instancias">',
    '<div class="rotulo">Estado de la gestión</div>',
    '<div class="definicion">La instancia la mueve un hecho con fecha, nunca el importe. No retrocede sola: sólo por pago total o por convenio firmado.</div>',
    cuadroAgregado("Instancia", v.resumen.porInstancia, v.resumen.total.texto),
    esFaltante(v.resumen.concentracion)
      ? `<div class="recuento"><span class="pendiente">${escapar(v.resumen.concentracion.motivo)}</span></div>`
      : `<div class="recuento">Las ${v.resumen.concentracion.unidades} unidades de mayor saldo concentran el ${escapar(v.resumen.concentracion.participacionTexto)} % del total ($ ${escapar(v.resumen.concentracion.importe.texto)}).</div>`,
    "</section>",
    v.detalle.modo === "nominado"
      ? [
          '<section class="seccion">',
          '<div class="rotulo">Detalle por unidad</div>',
          '<div class="definicion">Ordenado <strong>para trabajar</strong>: primero las instancias recuperables, al final las que ya están derivadas. Dentro de cada bloque, por antigüedad y después por saldo.</div>',
          tablaNominada(v as VistaListadoMora & { detalle: { modo: "nominado" } }),
          "</section>",
        ].join("")
      : '<div class="notas"><div>Esta versión no incluye el detalle por unidad. El detalle nominado, cuando el barrio lo tiene aprobado, se emite como un documento propio y con su propia lista de distribución.</div></div>',
    cierreDelDocumento(v),
  ].join("");

  return `<article class="doc">${franjaDeAcento(v.marca)}${hojaConCorridos(corrido, pie, contenido)}</article>`;
}

