import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BotonSecundarioSubmit, ShellAdministrador } from "@admin-barrios/ui";
import { salir } from "../../acciones/sesion.ts";
import { sesionActual } from "../../servidor/db.ts";

/**
 * Armazón de todas las pantallas del administrador.
 *
 * Resuelve la sesión una sola vez para la barra superior. Cada página vuelve a consultar con
 * `conSesion()`: este layout nombra al usuario y encierra el chrome, no autoriza datos.
 */

/*
 * **Todo lo que cuelga de este layout se rinde por request, nunca en el build.**
 *
 * Sin esto, `next build` intenta **prerenderizar estáticamente** `/` y, al hacerlo, ejecuta el
 * provider de identidad y la conexión a la base: compilar terminaba exigiendo `DATABASE_URL_APP`
 * y un adapter de Auth válido, y el gate de CI —que corre el build **a propósito sin ninguna URL**—
 * quedaba rojo. Normalmente Next lo deduce solo, porque leer cookies vuelve dinámica a la ruta;
 * acá no alcanza, porque la falla ocurre **mientras** resuelve la sesión, antes de que la señal
 * de dinamismo llegue a registrarse.
 *
 * No se pierde nada: **ninguna pantalla del administrador puede ser estática.** Todas dependen de
 * quién mira —la sesión decide qué barrios ve y qué datos le devuelve la RLS—, así que una versión
 * cacheada en el build sería, en el mejor caso, la de nadie.
 */
export const dynamic = "force-dynamic";
export default async function LayoutAdministrador({ children }: { children: ReactNode }) {
  const sesion = await sesionActual();
  if (!sesion) redirect("/entrar");

  return (
    <ShellAdministrador
      marca="admin-barrios"
      marcaHref="/"
      demo
      usuario={sesion.identidad.nombre ?? sesion.identidad.email ?? "sin nombre"}
      origen={sesion.origen}
      accionSesion={
        <form action={salir}>
          <BotonSecundarioSubmit>Salir</BotonSecundarioSubmit>
        </form>
      }
    >
      {children}
    </ShellAdministrador>
  );
}
