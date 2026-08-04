import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BotonSecundarioSubmit, ShellAdministrador } from "@admin-barrios/ui";
import { salir } from "../../acciones/sesion.ts";
import { sesionActual } from "../../servidor/db.ts";

/**
 * Armazon de todas las pantallas del administrador.
 *
 * Resuelve la sesion una sola vez para la barra superior. Cada pagina vuelve a consultar con
 * `conSesion()`: este layout nombra al usuario y encierra el chrome, no autoriza datos.
 */
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
