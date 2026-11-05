import { notFound, redirect } from "next/navigation";
import { esIdValido, rutaDeLiquidacion } from "../../../../../rutas.ts";

/** T2 (ADR-0011): el mes se abre solo, no hay «Nuevo período». El enlace viejo lleva al mes en curso. */
export default async function NuevoPeriodo({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio } = await params;
  if (!esIdValido(barrio)) notFound();
  redirect(rutaDeLiquidacion(barrio));
}
