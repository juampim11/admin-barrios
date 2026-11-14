"use client";

/**
 * «Padrón a una fecha» (encargo 15, `0078`): quiénes eran los titulares vigentes un día dado, en
 * planilla. La planilla la arma y la responde `GET /api/padron/planilla?tipo=a_una_fecha` (que exige
 * la administración y deja la traza de quién la bajó); esta isla solo pide la fecha y abre la
 * descarga. La fecha se mira con `fechaIsoSchema` de `shared` —el mismo esquema que valida la ruta—
 * para que una fecha vacía no termine en una página de error en vez de en el campo.
 */

import { useState } from "react";
import { fechaIsoSchema } from "@admin-barrios/shared/fechas";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { CampoTexto } from "../../../../componentes/formulario.tsx";

export function PadronAUnaFecha({ barrioId }: { readonly barrioId: string }) {
  const [error, setError] = useState<string[] | undefined>(undefined);
  // Cada descarga lanzada cambia el valor y cierra el diálogo.
  const [descargas, setDescargas] = useState<number | null>(null);

  const descargar = (form: FormData) => {
    const fecha = fechaIsoSchema.safeParse(form.get("fecha"));
    if (!fecha.success) {
      setError(["Elegí una fecha válida."]);
      return;
    }
    setError(undefined);
    const consulta = new URLSearchParams({ barrio: barrioId, tipo: "a_una_fecha", fecha: fecha.data });
    // La ruta responde la planilla como adjunto: el navegador la baja y la pantalla queda donde está.
    window.location.assign(`/api/padron/planilla?${consulta.toString()}`);
    setDescargas((n) => (n ?? 0) + 1);
  };

  return (
    <DialogoDeConfirmacion
      disparador="Padrón a una fecha"
      varianteDisparador="sutil"
      etiquetaDisparador="Bajar el padrón como estaba en una fecha"
      titulo="Padrón a una fecha"
      accion={descargar}
      textoVolver="Cancelar"
      textoConfirmar="Bajar la planilla"
      textoPendiente="Bajando…"
      pendiente={false}
      cerrarCon={descargas}
    >
      <p>
        Los titulares que tenía cada unidad ese día, con su carácter y el número de acción actual si el barrio lo usa.
        Las unidades sin titular ese día y las dadas de baja antes no aparecen. La descarga queda registrada.
      </p>
      <CampoTexto nombre="fecha" tipo="date" etiqueta="Fecha" requerido errores={error} />
    </DialogoDeConfirmacion>
  );
}
