import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { datosParaArmarPlan } from "@admin-barrios/data/servicios/planes-armar";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { ArmarPlan } from "../../../../../../componentes/planes/armar-plan.tsx";
import { EncabezadoDePagina, Nota, Pagina, Vacio } from "../../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutaDeFichaDeMora, rutaDeMoraDelBarrio, volverALaMora } from "../../../../../../rutas.ts";
import { subidaConfigurada } from "../../../../../../servidor/almacenamiento.ts";
import { conSesion } from "../../../../../../servidor/db.ts";

export const metadata: Metadata = { title: "Plan de pagos" };

/**
 * **Armar un plan de pagos** para una unidad (encargo P2a-2; maqueta de planes, pantallas 2 y 3).
 *
 * Una lectura bajo RLS (`datosParaArmarPlan`): los meses vencidos con su mora a hoy, los planes del
 * catálogo del barrio, sus estudios y sus reglas. El barrio de la URL elige, no autoriza: si la unidad
 * no es de ese barrio es un 404, igual que si no existiera. Lo interactivo es la isla (`ArmarPlan`).
 *
 * Si la unidad ya tiene un plan vigente o pendiente, no se arma otro: la página lo dice y lleva a la
 * ficha. Quien no administra el barrio la ve, pero sin formulario (lo decide de nuevo la base).
 *
 * **Desvíos de la maqueta**, con su motivo:
 *   · «Ver el acuerdo (PDF)» entra con el modelo de cláusulas y el PDF del plan (P2a-3).
 *   · «Acordado por» no va: un plan guarda el estudio solo si cobra él (`plan_pago_modo_chk`); quién
 *     lo negoció queda en el motivo. «Quién cobra» sí, y ofrece los estudios del barrio.
 */
export default async function ArmarPlanDePagos({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly unidad: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, unidad: unidadId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(unidadId)) notFound();
  const volver = volverALaMora((await searchParams)["volver"], rutaDeMoraDelBarrio(barrioId));
  const datos = await conSesion((tx) => datosParaArmarPlan(tx, { unidadFuncionalId: unidadId }));
  if (!datos || datos.barrio.id !== barrioId) notFound();

  const unidad = datos.unidad.etiqueta;
  const ficha = rutaDeFichaDeMora(barrioId, unidadId, { ver: "plan" });
  const bajada = [datos.titular ?? "Sin titular cargado en el padrón", datos.derivadaA ? `derivada a ${datos.derivadaA}` : null, `deuda al ${formatearFecha(datos.hoy)}`]
    .filter((x): x is string => x !== null)
    .join(" · ");

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio(datos.barrio),
          { texto: "Mora", href: volver },
          { texto: unidad, href: rutaDeFichaDeMora(barrioId, unidadId) },
          { texto: "Plan de pagos" },
        ]}
        titulo={`Plan de pagos · ${unidad}`}
        bajada={bajada}
        acciones={
          <Boton href={rutaDeFichaDeMora(barrioId, unidadId)} tamano="sm">
            Volver a la ficha
          </Boton>
        }
      />
      {datos.planAbierto ? (
        <Nota tono="info" titulo={datos.planAbierto.estado === "vigente" ? "La unidad ya tiene un plan vigente." : "La unidad tiene un plan pendiente de aprobación."}>
          Mientras siga, no se arma otro. <a href={ficha}>Ver el plan en la ficha</a>
        </Nota>
      ) : !datos.puedeArmar ? (
        <Nota tono="neutro" titulo="Los planes los arma la administración del barrio.">
          Desde acá se ve la deuda, pero no se registra un plan.
        </Nota>
      ) : datos.meses.length === 0 ? (
        <Vacio titulo="No tiene meses vencidos para un plan">
          Lo que debe todavía no venció: sigue en la boleta como expensa del mes. <a href={ficha}>Volver a la ficha</a>
        </Vacio>
      ) : (
        <ArmarPlan datos={datos} subidaConfigurada={subidaConfigurada()} />
      )}
    </Pagina>
  );
}
