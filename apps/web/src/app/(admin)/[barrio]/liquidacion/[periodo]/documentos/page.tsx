import { notFound, redirect } from "next/navigation";
import { esIdValido } from "../../../../../../rutas.ts";

/**
 * Pantalla del circuito viejo (T2, ADR-0011): documentos se fue con «Generar el borrador» y los botones de
 * después de emitir. Los enlaces que todavía la nombran llegan a su reemplazo: envio.
 */
export default async function Redireccion({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio, periodo } = await params;
  if (!esIdValido(barrio) || !esIdValido(periodo)) notFound();
  redirect(`/${barrio}/liquidacion/${periodo}/envio`);
}
