/**
 * Lo que las dos pantallas de configuración (del barrio y general) dibujan igual: el valor de un
 * parámetro como texto, sus marcas de origen y el historial de vigencias.
 *
 * Es de servidor y no decide nada: el valor vigente, su origen y qué está programado los resolvió la
 * base (`app.parametro_resuelto()`, vía `leerConfiguracion*`). Acá solo se **dice**. Los formatos
 * salen de `@admin-barrios/shared` —`formatearMonto`, `formatearFecha`, `textoDeValor`—, nunca de
 * `Intl` ni `toLocale*` (regla 6).
 */

import type { ReactNode } from "react";
import type { FilaDeHistorial, ValorVigente } from "@admin-barrios/data/servicios/parametros";
import { Chip, DatoEnLinea, TextoDeOrigen } from "@admin-barrios/ui";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import {
  definicionDe,
  ETIQUETA_RESPALDO,
  fraccionAPorcentaje,
  REGISTRO_PARAMETROS,
  textoDeValor,
  type ClaveParametro,
  type DefinicionParametro,
} from "@admin-barrios/shared/parametros-mora";
import { Desplegable, MarcoTabla, Tabla } from "../../../../componentes/ui.tsx";

/** Los grupos, en el orden del registro. */
export const GRUPOS: readonly DefinicionParametro["grupo"][] = [...new Set(REGISTRO_PARAMETROS.map((d) => d.grupo))];

/** El ancla de la tarjeta de un parámetro. La confirmación de «Cobra interés» manda a la de la imputación. */
export const anclaDe = (clave: ClaveParametro): string => `parametro-${clave.replace(".", "-").replaceAll("_", "-")}`;

/**
 * Un valor, como se lee. `null` es **sin definir** —pasa con el orden de imputación en una
 * administración migrada— y se dice así, no se rellena con el valor inicial del producto.
 */
export function textoDelValor(clave: ClaveParametro, valor: unknown): string {
  if (valor === null || valor === undefined) return "sin definir";
  if (definicionDe(clave).tipo === "pesos") return `$ ${formatearMonto(String(valor))}`;
  return textoDeValor(clave, valor);
}

/** El renglón chico al lado del valor grande. Solo las tasas lo tienen: son mensuales. */
export const unidadDe = (clave: ClaveParametro): string | undefined =>
  definicionDe(clave).tipo === "tasa" ? "mensual" : undefined;

/**
 * Lo que va de entrada en el campo del formulario: la forma en que lo **tipea** una persona, que es
 * la que espera `fijarParametroSchema`. El importe va en canónico porque lo pinta `CampoMonto`.
 */
export function valorParaFormulario(clave: ClaveParametro, valor: unknown): string | undefined {
  if (valor === null || valor === undefined) return undefined;
  switch (definicionDe(clave).tipo) {
    case "sino":
      return valor === true ? "si" : "no";
    case "tasa":
      return fraccionAPorcentaje(String(valor));
    default:
      return String(valor);
  }
}

/** A qué se aplica un cambio, según de qué se trate. Un orden de imputación no se cuenta en días de atraso. */
export function desdeCuandoSeAplica(clave: ClaveParametro): string {
  if (definicionDe(clave).grupo === "Imputación de pagos") {
    return "Se aplica a los pagos que se imputen desde la fecha elegida; lo ya imputado no cambia.";
  }
  // Cobra y las tasas pesan día por día; gracia, forma y tolerancia se toman al inicio de cada
  // período de atraso (`interes-mora.ts`, regla 3). Decir lo mismo para todas sería falso.
  return clave === "interes.cobra" || clave === "interes.tasa_compensatoria" || clave === "interes.tasa_punitoria"
    ? "Se aplica a los días de atraso desde la fecha elegida; las boletas ya emitidas no cambian."
    : "Se aplica a los atrasos que empiecen desde la fecha elegida; las boletas ya emitidas no cambian.";
}

/**
 * Desde cuándo rige el valor de hoy. Un valor que nadie cargó —el inicial del producto o el migrado
 * del esquema anterior— **se dice como tal**, con un chip, y no con una fecha que nadie eligió.
 */
export function RigeDesde({ vigente }: { readonly vigente: ValorVigente | null }): ReactNode {
  if (!vigente) return null;
  if (vigente.carga === "inicial") return <Chip tono="neutro">Valor inicial</Chip>;
  if (vigente.carga === "migrado") {
    return (
      <>
        <Chip tono="neutro">Valor migrado</Chip>
        <TextoDeOrigen>
          rige desde el <DatoEnLinea>{formatearFecha(vigente.vigenteDesde)}</DatoEnLinea>
        </TextoDeOrigen>
      </>
    );
  }
  return (
    <TextoDeOrigen>
      Rige desde el <DatoEnLinea>{formatearFecha(vigente.vigenteDesde)}</DatoEnLinea>
    </TextoDeOrigen>
  );
}

/** El chip de un cambio que todavía no rige. */
export function ChipDeProgramado({
  clave,
  fila,
  sufijo,
}: {
  readonly clave: ClaveParametro;
  readonly fila: FilaDeHistorial;
  readonly sufijo?: string;
}) {
  const que = fila.valor === null ? "vuelve al valor general" : textoDelValor(clave, fila.valor);
  return (
    <Chip tono="info" icono={<span aria-hidden>◷</span>}>
      Cambio programado · desde {formatearFecha(fila.vigenteDesde)}: {que}
      {sufijo ? ` ${sufijo}` : ""}
    </Chip>
  );
}

/**
 * El historial de vigencias de un nivel: cada fila con su fecha, su valor, por qué se cargó y de qué
 * instrumento sale. Colapsado (`<details>`, cero JavaScript): es lo que se abre cuando alguien
 * pregunta "¿desde cuándo es así y quién lo decidió?".
 */
export function HistorialDeVigencias({
  titulo,
  clave,
  filas,
  vigenteFilaId,
}: {
  readonly titulo: string;
  readonly clave: ClaveParametro;
  readonly filas: readonly FilaDeHistorial[];
  /** La fila que rige hoy, para marcarla. */
  readonly vigenteFilaId: string | null;
}) {
  if (filas.length === 0) return null;
  return (
    <Desplegable resumen={`${titulo} (${filas.length})`}>
      <MarcoTabla etiqueta={titulo}>
        <Tabla>
          <thead>
            <tr>
              <th scope="col">Desde</th>
              <th scope="col">Valor</th>
              <th scope="col">Motivo</th>
              <th scope="col">Respaldo</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.filaId}>
                <td>{f.carga === "inicial" ? "Valor inicial" : formatearFecha(f.vigenteDesde)}</td>
                <td>{f.valor === null ? "vuelve al valor general" : textoDelValor(clave, f.valor)}</td>
                <td>{f.carga === "migrado" ? `${f.motivo} (migrado)` : f.motivo || "—"}</td>
                <td>
                  {f.respaldo ? (
                    <>
                      {ETIQUETA_RESPALDO[f.respaldo.tipo]} · {f.respaldo.referencia}
                      {f.respaldo.adjunto ? (
                        <>
                          {" "}
                          {/* Un `<a>` y no `Link`: es una descarga (redirección a una URL firmada). */}
                          <a href={`/api/respaldos/${f.filaId}`}>Ver adjunto</a>
                        </>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {f.anulada
                    ? `Anulado: ${f.anulada.motivo}`
                    : f.programada
                      ? "Programado"
                      : f.filaId === vigenteFilaId
                        ? "Rige hoy"
                        : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </MarcoTabla>
    </Desplegable>
  );
}

/** «1 barrio» / «3 barrios». */
export const barrios = (n: number): string => (n === 1 ? "1 barrio" : `${n} barrios`);

/** «1 unidad» / «212 unidades». */
export const unidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);

/** El parámetro `filtro` de la URL, acotado a los valores que la pantalla conoce. */
export function filtroDe<F extends string>(
  crudo: string | string[] | undefined,
  validos: readonly F[],
  porDefecto: F,
): F {
  const valor = Array.isArray(crudo) ? crudo[0] : crudo;
  return validos.find((v) => v === valor) ?? porDefecto;
}
