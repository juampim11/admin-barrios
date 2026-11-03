import type { Metadata } from "next";
import Link from "next/link";
import { listarBarriosAccesibles } from "@admin-barrios/data/servicios/barrios";
import { administracionesDondeCrear } from "@admin-barrios/data/servicios/padron-edicion";
import { leerConfiguracionGeneral } from "@admin-barrios/data/servicios/parametros";
import { codigoDePago, FORMATO_CODIGO_PAGO_INICIAL } from "@admin-barrios/shared/codigo-pago";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { definicionDe, type ClaveParametro } from "@admin-barrios/shared/parametros-mora";
import { IconoBarrio } from "../../../../componentes/iconos.tsx";
import { EncabezadoDePagina, Pagina, Vacio } from "../../../../componentes/ui.tsx";
import { rutaDeConfiguracionGeneral } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { textoDelValor, unidadDe } from "../../[barrio]/configuracion/vista.tsx";
import estilosAdmin from "../../admin.module.css";
import { FormularioNuevoBarrio, type MoraDeLaAdministracion } from "./formulario.tsx";

export const metadata: Metadata = { title: "Nuevo barrio" };

/** Lo que la nota de la sección 4 cita de la configuración general (maqueta: «Cobra interés: Sí», 3 %…). */
const CLAVES_DE_LA_NOTA: readonly ClaveParametro[] = [
  "interes.cobra",
  "interes.tasa_compensatoria",
  "interes.gracia_dias",
  "imputacion.orden",
];

/** `"2026-12"` → `"2027-01"`. Aritmética de texto: nada de `Date` (regla 7). */
function mesSiguiente(periodo: string): string {
  const [anio = "0", mes = "0"] = periodo.split("-");
  const a = Number.parseInt(anio, 10);
  const m = Number.parseInt(mes, 10);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * **Nuevo barrio** (maqueta T3 aprobada, pantalla 2). Servidor: resuelve dónde se puede crear, qué
 * día es hoy para la base, la mora que el barrio va a heredar de cada administración y los ejemplos
 * del código de pago; la isla (`formulario.tsx`) solo dibuja y envía.
 *
 * **Hoy y la mora salen de la configuración general**, que se lee entrando por un barrio de esa
 * administración (así está hecho el servicio). Si la administración todavía no tiene ningún barrio
 * —el primero de un estudio nuevo— no hay por dónde entrar: la nota de la mora se dice sin valores y
 * el primer período se tipea en vez de elegirse. Anotado como hueco del backend en `HANDOFF.md`.
 */
export default async function NuevoBarrio() {
  const datos = await conSesion(async (tx) => {
    const administraciones = await administracionesDondeCrear(tx);
    const barrios = await listarBarriosAccesibles(tx);
    const mora: Record<string, MoraDeLaAdministracion> = {};
    let hoy: string | null = null;
    // Secuencial a propósito: `node-postgres` encola las consultas del mismo client. Son pocas
    // administraciones (una, casi siempre).
    for (const a of administraciones) {
      const entrada = barrios.find((b) => b.administrador?.id === a.id);
      if (!entrada) {
        mora[a.id] = { resumen: null, href: null };
        continue;
      }
      const cfg = await leerConfiguracionGeneral(tx, { barrioId: entrada.id });
      hoy ??= cfg?.hoy || null;
      mora[a.id] = {
        resumen: cfg
          ? CLAVES_DE_LA_NOTA.flatMap((clave) => {
              const p = cfg.parametros.find((x) => x.clave === clave);
              if (!p?.vigente) return [];
              const unidad = unidadDe(clave);
              return [`${definicionDe(clave).nombre}: ${textoDelValor(clave, p.vigente.valor)}${unidad ? ` ${unidad}` : ""}`];
            })
          : null,
        href: rutaDeConfiguracionGeneral(entrada.id),
      };
    }
    return { administraciones, mora, hoy };
  });

  if (datos.administraciones.length === 0) {
    return (
      <main id="contenido">
        <Pagina>
          <EncabezadoDePagina titulo="Nuevo barrio" />
          <Vacio icono={<IconoBarrio />} titulo="Con tu usuario no se pueden crear barrios">
            Crear un barrio es de quien administra la administración (administrador de la administración o
            de la plataforma). <Link href="/">Volver a Barrios</Link>.
          </Vacio>
        </Pagina>
      </main>
    );
  }

  const actual = datos.hoy ? datos.hoy.slice(0, 7) : null;
  const periodos = actual
    ? {
        actual: { valor: actual, texto: formatearPeriodo(actual) },
        siguiente: { valor: mesSiguiente(actual), texto: formatearPeriodo(mesSiguiente(actual)) },
      }
    : null;
  const unaSola = datos.administraciones.length === 1 ? datos.administraciones[0] : undefined;

  return (
    <main id="contenido">
      <Pagina>
        <nav className={estilosAdmin.migas} aria-label="Ruta">
          <ol>
            {unaSola ? <li>{unaSola.nombre}</li> : null}
            <li>
              <Link href="/">Barrios</Link>
            </li>
            <li aria-current="page">Nuevo barrio</li>
          </ol>
        </nav>
        <EncabezadoDePagina
          titulo="Nuevo barrio"
          bajada="Lo obligatorio es lo que hace falta para liquidar. El resto se completa ahora o después, desde Configuración del barrio."
        />
        <FormularioNuevoBarrio
          administraciones={datos.administraciones}
          mora={datos.mora}
          periodos={periodos}
          mandatoSugerido={actual ? `${actual}-01` : undefined}
          ejemploCodigo={codigoDePago(1, FORMATO_CODIGO_PAGO_INICIAL)}
          ejemploCodigoConPrefijo={codigoDePago(1, { ...FORMATO_CODIGO_PAGO_INICIAL, prefijo: "12" })}
        />
      </Pagina>
    </main>
  );
}
