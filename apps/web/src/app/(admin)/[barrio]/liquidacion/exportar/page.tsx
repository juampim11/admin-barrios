import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { puedeExportarMovimientos } from "@admin-barrios/data/servicios/exportaciones";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { MAXIMO_MESES_EXPORTACION } from "@admin-barrios/shared/consultas";
import { clasesDeBoton } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../componentes/iconos.tsx";
import { EncabezadoDePagina, Pagina, Panel, Vacio } from "../../../../../componentes/ui.tsx";
import { esIdValido } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import estilos from "./exportar.module.css";

export const metadata: Metadata = { title: "Exportar movimientos" };

/**
 * La planilla de movimientos para el contador (doc 01 §4.8, ADR-0004).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * ESTA PANTALLA NO TIENE UNA SOLA LÍNEA DE JAVASCRIPT, Y NO ES UN ATAJO
 *
 * Es un `<form method="get">` que apunta derecho a la ruta de la API. El navegador arma la URL con
 * los dos parámetros y dispara la descarga: exactamente lo que haría una isla de cliente, sin
 * enviarle un bundle a nadie. La regla 8 del repo dice que las pantallas de lectura cuestan cero
 * JavaScript y que eso se conserva; acá se conserva.
 *
 * Lo único que una isla agregaría es validar en el navegador que el período final no sea anterior al
 * inicial. Eso **ya lo valida Zod en la ruta** (`consultaExportacionSchema`), que es donde tiene que
 * estar igual, porque la URL se puede escribir a mano. Duplicarlo en el cliente sería una segunda
 * definición de la misma regla, que es lo que el proyecto evita en los formularios (regla 9).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL ACCESO NO SE DIBUJA SI EL ROL NO PUEDE EXPORTAR
 *
 * `puedeExportarMovimientos()` decide si esta pantalla existe para quien la pide, con la misma
 * condición que la policy de `insert` de `exportacion_movimientos`. **No es la autorización**: esa la
 * hace la base cuando se registra la traza, y por eso escribir la URL de la API a mano tampoco sirve.
 * Es la regla de no ofrecer un control que después rebota (doc 06 §c.6.4) — mismo criterio que
 * `puedeEmitir` en la grilla del período y los `puedeXxx` de órdenes de pago.
 */
export default async function ExportarMovimientos({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    periodos: await listarPeriodos(tx, { barrioId }),
    puedeExportar: await puedeExportarMovimientos(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  // Un rol sin permiso no ve una pantalla vacía ni un aviso: no ve la pantalla. Mismo tratamiento
  // que un barrio que no le corresponde.
  if (!datos.puedeExportar) notFound();

  const { barrio, periodos } = datos;
  // Del más viejo al más nuevo: es el orden natural de un rango, y `listarPeriodos` los trae al revés.
  const enOrden = [...periodos].reverse();
  const masNuevo = enOrden.at(-1);
  const conProvisorios = periodos.some((p) => p.estado !== "emitida" && p.estado !== "distribuida");

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Exportar movimientos"
        bajada={`Los ingresos y egresos de ${barrio.nombre}, en una planilla para entregarle al contador.`}
      />

      {enOrden.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no hay períodos">
          La planilla se arma sobre los períodos del barrio. Cuando exista el primero, se puede
          exportar desde acá.
        </Vacio>
      ) : (
        <Panel
          titulo="Rango a exportar"
          origen={
            <>
              La planilla sale en <strong>Excel (.xlsx)</strong>, con una hoja de cobranzas, una de
              cómo se aplicaron a cada período, una de egresos y una de anulaciones. Es un{" "}
              <strong>extracto de movimientos registrados</strong>: no calcula impuestos ni reemplaza
              una liquidación impositiva.
            </>
          }
        >
          <form method="get" action="/api/exportaciones/movimientos" className={estilos.rango}>
            <input type="hidden" name="barrio" value={barrio.id} />

            <label className={estilos.campo}>
              <span>Desde el período</span>
              <select name="desde" defaultValue={enOrden[0]?.periodo}>
                {enOrden.map((p) => (
                  <option key={p.id} value={p.periodo}>
                    {formatearPeriodo(p.periodo)}
                  </option>
                ))}
              </select>
            </label>

            <label className={estilos.campo}>
              <span>Hasta el período</span>
              <select name="hasta" defaultValue={masNuevo?.periodo}>
                {enOrden.map((p) => (
                  <option key={p.id} value={p.periodo}>
                    {formatearPeriodo(p.periodo)}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className={clasesDeBoton({ variante: "primario" })}>
              Descargar planilla
            </button>
          </form>

          <p>
            El rango no puede superar los <strong>{MAXIMO_MESES_EXPORTACION} meses</strong>.
            {conProvisorios ? (
              <>
                {" "}
                Si incluís algún período que todavía no se emitió, la planilla sale marcada{" "}
                <strong>PROVISORIO</strong>: la clasificación fiscal de esas líneas sale del catálogo
                vigente y puede cambiar cuando el período se emita.
              </>
            ) : null}
          </p>
        </Panel>
      )}
    </Pagina>
  );
}
