/**
 * Los textos de «Resultado del mes» (encargo 16c, pantalla 7 de la maqueta), como funciones puras.
 *
 * No calculan nada: las cifras y sus diferencias las da `resultadoDelMes`. Acá se dice qué quiere
 * decir cada diferencia, de dónde sale cada cifra (las definiciones de los docstrings de
 * `ResultadoDelMes`) y qué pasa con lo que sobró en la cuenta.
 */

import { aCentavos, formatearMonto } from "@admin-barrios/shared/dinero";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";

const signo = (monto: string): -1 | 0 | 1 => {
  const c = aCentavos(monto);
  return c > 0n ? 1 : c < 0n ? -1 : 0;
};

/** Devengado − gastado, en palabras. */
export function lecturaDeLosPapeles(diferencia: string): string {
  switch (signo(diferencia)) {
    case 1:
      return "Se pidió más de lo que se gastó";
    case -1:
      return "Se gastó más de lo que se pidió";
    case 0:
      return "Se pidió lo mismo que se gastó";
  }
}

/** Cobrado − pagado, en palabras. */
export function lecturaDeLaCuenta(diferencia: string): string {
  switch (signo(diferencia)) {
    case 1:
      return "Entró más de lo que salió";
    case -1:
      return "Salió más de lo que entró";
    case 0:
      return "Entró lo mismo que salió";
  }
}

/** De dónde sale cada cifra (regla 4 de `CLAUDE.md`). */
export const ORIGEN = {
  devengado: "Lo que pidieron las boletas del mes, sin la deuda que arrastran ni el interés por mora.",
  gastado: "Los gastos cargados en el mes; un ajuste negativo resta.",
  cobrado: "Los pagos registrados con fecha en el mes, sin los anulados ni el saldo a favor que se trajo al activar el barrio.",
  pagado: "Las órdenes de pago pagadas con fecha de pago en el mes.",
  faltaCobrar: "Lo que todavía se debe hoy de las boletas de este mes, sin interés.",
} as const;

/** «5 unidades lo deben» / «Ninguna unidad lo debe». */
export function quienesLoDeben(unidades: number): string {
  if (unidades === 0) return "Ninguna unidad lo debe";
  return unidades === 1 ? "1 unidad lo debe" : `${unidades} unidades lo deben`;
}

/**
 * El sobrante del mes, solo en palabras: qué hacer con él todavía no se puede decidir acá, y no se
 * promete cuándo. Si la cuenta no dejó nada, se dice.
 */
export function sobranteDelMes(periodo: string, diferenciaEnLaCuenta: string): string {
  const mes = nombreDelPeriodo(periodo).split(" ")[0]!;
  if (signo(diferenciaEnLaCuenta) <= 0) return `${mes} no dejó sobrante en la cuenta.`;
  return (
    `${mes} dejó $ ${formatearMonto(diferenciaEnLaCuenta)} en la cuenta: entró más de lo que salió. ` +
    "Qué hacer con un sobrante —pasarlo al fondo de reserva, dejarlo en la cuenta del barrio o descontarlo del mes siguiente— " +
    "se va a poder decidir acá más adelante. Por ahora el sistema solo lo muestra: no mueve plata."
  );
}
