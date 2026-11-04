import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { coeficientesDelBarrio, leerBarrioDelPadron, puedeEditarPadron } from "@admin-barrios/data/servicios/padron-edicion";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { EncabezadoDePagina, Nota, Pagina, Panel } from "../../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutaDelPadron } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FormularioDeNuevaVersion } from "../nueva-version.tsx";

export const metadata: Metadata = { title: "Nueva versión de coeficientes" };

/** `"2026-12"` → `["2026-12", "2027-01", "2027-02"]`. Aritmética de texto: sin `Date`. */
function periodosDesde(periodo: string, cuantos: number): string[] {
  const [anio = "0", mes = "1"] = periodo.split("-");
  const base = Number.parseInt(anio, 10) * 12 + (Number.parseInt(mes, 10) - 1);
  return Array.from({ length: cuantos }, (_, i) => {
    const n = base + i;
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
  });
}

/**
 * Una versión nueva de coeficientes, en su página (encargo 9, PR 1 §2): la lista de versiones con el
 * botón en la cabecera y acá el formulario, con «Cancelar» que vuelve a la lista y, al guardar, la
 * lista con «Listo:». Solo para quien puede editar el padrón (dato para la UI; decide la base).
 */
export default async function NuevaVersionDeCoeficientes({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrioDelPadron(tx, { barrioId });
    if (!barrio) return null;
    return {
      barrio,
      coeficientes: await coeficientesDelBarrio(tx, { barrioId }),
      puedeEditar: await puedeEditarPadron(tx, { barrioId }),
    };
  });
  if (!datos) notFound();
  const { barrio, coeficientes, puedeEditar } = datos;
  const lista = `${rutaDelPadron(barrio.id)}/coeficientes`;
  const periodos = periodosDesde(barrio.proximoPeriodo, 3).map((p, i) => ({
    valor: p,
    texto: i === 0 ? `${formatearPeriodo(p)} (próximo período)` : formatearPeriodo(p),
  }));

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio(barrio),
          { texto: "Padrón", href: rutaDelPadron(barrio.id) },
          { texto: "Coeficientes", href: lista },
          { texto: "Nueva versión" },
        ]}
        titulo="Nueva versión de coeficientes"
        bajada="Rige desde un período y suma 1 exacto. Una versión que ya se usó para liquidar no se modifica."
      />
      {puedeEditar ? (
        <Panel>
          <FormularioDeNuevaVersion
            barrioId={barrio.id}
            periodos={periodos}
            unidadesActivas={coeficientes.unidadesActivas}
            conSuperficie={coeficientes.conSuperficie}
            superficieTotal={coeficientes.superficieTotal === null ? null : formatearDecimal(coeficientes.superficieTotal, 2)}
            volverA={lista}
          />
        </Panel>
      ) : (
        <Nota tono="info" titulo="Tu rol no crea versiones de coeficientes en este barrio.">
          Lo hace un administrador del barrio.{" "}
          <Boton href={lista} variante="sutil" tamano="sm">
            Volver a los coeficientes
          </Boton>
        </Nota>
      )}
    </Pagina>
  );
}
