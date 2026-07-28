/**
 * La grilla de liquidaciones por unidad — **una sola definición para las dos pantallas que la usan**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO SE EXTRAJO, CON EL BUG QUE LO PROVOCÓ
 *
 * La pantalla de revisión arrancó con una versión "simplificada" de la grilla: siete columnas en vez
 * de las diez del resumen, eligiendo las que parecían más importantes. Medido contra la base el
 * 2026-07-28, ese recorte producía esto:
 *
 * > `Ordinarias $0,00 · Cargos $0,00 · Descuentos $0,00 · Saldo anterior $0,00 · Interés $0,00`
 * > `→ Total de la boleta $9.562,10`
 *
 * Los $9.562,10 estaban repartidos entre `subtotal_extraordinarias` y `subtotal_fondo_reserva`, que
 * eran justo dos de las tres columnas que el recorte había dejado afuera. O sea: **la pantalla donde
 * se decide emitir mostraba una fila de ceros y un total que no se explica con nada de lo que se ve**,
 * que es exactamente lo contrario de la regla dura del proyecto (ninguna cifra sin su origen).
 *
 * La lección no es "me faltaron columnas": es que **dos definiciones de las mismas columnas divergen
 * siempre**. Es el mismo error que este archivo ya había corregido una vez adentro del resumen, donde
 * el panel de cierre y el encabezado de la grilla clasificaban las mismas seis columnas de dos formas
 * distintas a trescientas líneas de distancia. Con una sola fuente, la contradicción no se puede
 * escribir.
 *
 * **Server Component, cero JavaScript**: la grilla es lectura pura y en un barrio grande son cientos
 * de filas. Lo interactivo de esas pantallas (generar el borrador, emitir) vive en sus propios
 * módulos de cliente.
 */

import type { GrillaLiquidaciones, LiquidacionDeGrilla } from "@admin-barrios/data/servicios/liquidaciones";
import { Cifra, Coeficiente, MarcoTabla, Tabla, ui } from "../../../../../componentes/ui.tsx";
import estilos from "./grilla.module.css";

/**
 * Los tres grupos de columnas.
 *
 * Antes eran dos —"Del período" y "Arrastre"— con cargos y descuentos metidos en el primero, mientras
 * que la cifra "Repartido a las unidades" del panel de cierre los dejaba afuera. Con tres grupos,
 * `reparto` es exactamente lo que esa cifra suma y las dos piezas no se pueden contradecir.
 */
export const GRUPOS = {
  reparto: "Prorrateo del mes",
  ajustes: "Ajustes de la unidad",
  arrastre: "Viene de antes",
} as const;

export type Grupo = keyof typeof GRUPOS;

export type Columna = {
  readonly clave: string;
  readonly titulo: string;
  readonly grupo: Grupo;
  readonly valor: (l: LiquidacionDeGrilla) => string | null;
  readonly total: string;
  readonly nulo: string;
  readonly signo?: boolean;
  /** Se muestra aunque esté en cero: sin ella la grilla dejaría de explicar el reparto. */
  readonly siempre?: boolean;
};

/**
 * Las ocho columnas de subtotales, con su grupo y su total.
 *
 * **Son todas las que tiene la liquidación, y por eso la fila cierra.** Cualquier recorte acá vuelve
 * a producir el bug de arriba: un total que no se explica con las columnas que se ven.
 */
export function columnasDe(grilla: GrillaLiquidaciones): readonly Columna[] {
  const t = grilla.totales;
  return [
    { clave: "cuotaFija", titulo: "Cuota fija", grupo: "reparto", valor: (l) => l.subtotalCuotaFija, total: t.cuotaFija, nulo: "—" },
    { clave: "ordinarias", titulo: "Ordinarias", grupo: "reparto", valor: (l) => l.subtotalOrdinarias, total: t.ordinarias, nulo: "—", siempre: true },
    { clave: "extraordinarias", titulo: "Extraordinarias", grupo: "reparto", valor: (l) => l.subtotalExtraordinarias, total: t.extraordinarias, nulo: "—" },
    { clave: "fondoReserva", titulo: "Fondo de reserva", grupo: "reparto", valor: (l) => l.subtotalFondoReserva, total: t.fondoReserva, nulo: "—" },
    { clave: "cargos", titulo: "Cargos", grupo: "ajustes", valor: (l) => l.subtotalCargos, total: t.cargos, nulo: "—", signo: true },
    { clave: "descuentos", titulo: "Descuentos", grupo: "ajustes", valor: (l) => l.subtotalDescuentos, total: t.descuentos, nulo: "—", signo: true },
    { clave: "saldoAnterior", titulo: "Saldo anterior", grupo: "arrastre", valor: (l) => l.saldoAnterior, total: t.saldoAnterior, nulo: "—" },
    { clave: "interesMora", titulo: "Interés por mora", grupo: "arrastre", valor: (l) => l.interesMora, total: t.interesMora, nulo: "pendiente" },
  ];
}

/** Las columnas de un grupo, en el orden en que se muestran. */
export const delGrupo = (columnas: readonly Columna[], grupo: Grupo): readonly Columna[] =>
  columnas.filter((c) => c.grupo === grupo);

/**
 * Qué columnas se ven y cuáles se ocultan por estar en cero — **decidido una vez y devuelto**, para
 * que la pantalla pueda declarar al pie lo que se ocultó.
 *
 * Una columna se oculta solo si **ninguna fila** tiene algo ahí, y no si su total da cero. La
 * diferencia no es teórica y es plata: `saldo_anterior` es `numeric(14,2)` sin check de signo, así que
 * un saldo a favor es negativo. Con el criterio "el total da cero", una unidad con +180.000 y otra
 * con −180.000 hacen desaparecer la columna entera, y el pie declara "columnas en cero, ocultas:
 * saldo anterior" — o sea, la pantalla donde se decide emitir afirma que no hay arrastre cuando hay
 * 360.000 pesos de arrastre. Con `every()` eso no puede pasar: una columna oculta es una columna
 * donde **todas** las filas dicen cero.
 */
export function visiblesDe(grilla: GrillaLiquidaciones, todas: readonly Columna[]) {
  const enCero = (c: Columna) => grilla.liquidaciones.every((l) => (c.valor(l) ?? "0.00") === "0.00");
  const visibles = todas.filter((c) => c.siempre === true || !enCero(c));
  return { visibles, ocultas: todas.filter((c) => !visibles.includes(c)) };
}

/**
 * La tabla: una fila por unidad, con los subtotales que explican su total.
 *
 * **1. Encabezado de dos niveles.** El agrupado *es* la explicación: sin él, saldo anterior e interés
 * parecen parte del reparto del mes y no lo son.
 *
 * **2. La fila de totales es la suma de lo que se ve**, no una agregación aparte. Que el
 * administrador pueda sumar la columna a mano y llegar al mismo número es la forma barata de que la
 * cifra sea auditable.
 */
export function GrillaDeLiquidaciones({
  grilla,
  visibles,
}: {
  readonly grilla: GrillaLiquidaciones;
  readonly visibles: readonly Columna[];
}) {
  // Los grupos que quedaron con al menos una columna visible, en orden. Un grupo entero en cero no
  // deja un encabezado vacío colgando.
  const gruposVisibles = (Object.keys(GRUPOS) as Grupo[])
    .map((grupo) => ({ grupo, columnas: delGrupo(visibles, grupo) }))
    .filter(({ columnas }) => columnas.length > 0);

  /** El separador cae en la primera columna de cada grupo: es lo que hace legible el agrupado. */
  const abreGrupo = (i: number) => i === 0 || visibles[i]?.grupo !== visibles[i - 1]?.grupo;

  return (
    <MarcoTabla etiqueta="Liquidaciones del período por unidad funcional">
      <Tabla>
        <thead>
          <tr>
            <th scope="col" rowSpan={2} className={ui.columnaAncla}>
              Unidad
            </th>
            <th scope="col" rowSpan={2} className={ui.numerica}>
              Coeficiente
            </th>
            {gruposVisibles.map(({ grupo, columnas }) => (
              <th key={grupo} scope="colgroup" colSpan={columnas.length} className={ui.grupoDeColumnas}>
                {GRUPOS[grupo]}
              </th>
            ))}
            <th scope="col" rowSpan={2} className={`${ui.numerica} ${ui.columnaTotal}`}>
              Total
            </th>
          </tr>
          <tr>
            {visibles.map((c, i) => (
              <th
                key={c.clave}
                scope="col"
                className={`${ui.numerica} ${abreGrupo(i) ? ui.separadorIzquierdo : ""}`}
              >
                {c.titulo}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grilla.liquidaciones.map((l) => (
            <tr key={l.id}>
              <th scope="row" className={ui.columnaAncla}>
                <span className={estilos.unidadEnGrilla}>
                  <span className={estilos.etiquetaUnidad}>{l.etiqueta}</span>
                  <span className={ui.secundaria}>{l.destinatario ?? "sin obligado notificado"}</span>
                  {l.numeroComprobante ? (
                    <span className={`${ui.secundaria} ${ui.mono}`}>{l.numeroComprobante}</span>
                  ) : null}
                </span>
              </th>
              <td className={ui.numerica}>
                <Coeficiente valor={l.coeficienteAplicado} nulo="—" />
              </td>
              {visibles.map((c, i) => (
                <td
                  key={c.clave}
                  className={`${ui.numerica} ${abreGrupo(i) ? ui.separadorIzquierdo : ""}`}
                >
                  <Cifra monto={c.valor(l)} nulo={c.nulo} signo={c.signo === true} />
                  {c.clave === "interesMora" && l.moraPendienteDefinicion ? (
                    <>
                      <br />
                      <span className={estilos.pendiente}>sin tasa</span>
                    </>
                  ) : null}
                  {c.clave === "interesMora" && l.diasAtraso !== null ? (
                    <>
                      <br />
                      <span className={ui.secundaria}>{l.diasAtraso} días</span>
                    </>
                  ) : null}
                </td>
              ))}
              <td className={`${ui.numerica} ${ui.columnaTotal} ${ui.principal}`}>
                <Cifra monto={l.total} nulo="—" />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className={ui.columnaAncla}>
              {grilla.liquidaciones.length} unidades
            </th>
            <td className={ui.numerica}>
              <span className={ui.secundaria}>no se suma</span>
            </td>
            {visibles.map((c, i) => (
              <td
                key={c.clave}
                className={`${ui.numerica} ${abreGrupo(i) ? ui.separadorIzquierdo : ""}`}
              >
                <Cifra monto={c.total} nulo="—" signo={c.signo === true} />
              </td>
            ))}
            <td className={`${ui.numerica} ${ui.columnaTotal}`}>
              <Cifra monto={grilla.totales.total} nulo="—" />
            </td>
          </tr>
        </tfoot>
      </Tabla>
    </MarcoTabla>
  );
}

/** El renglón del pie que declara qué columnas se ocultaron. Nada desaparece en silencio. */
export function ColumnasOcultas({ ocultas }: { readonly ocultas: readonly Columna[] }) {
  if (ocultas.length === 0) return null;
  return (
    <>
      Columnas ocultas porque <strong>todas</strong> las liquidaciones las tienen en cero:{" "}
      {ocultas.map((c) => c.titulo.toLowerCase()).join(" · ")}.{" "}
    </>
  );
}
