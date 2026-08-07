import { notFound, redirect } from "next/navigation";
import { esIdValido } from "../../../rutas.ts";

/**
 * `/{barrio}` no tiene contenido propio: la home del barrio es su tablero (doc 06 §c.4, ADR-0002 §7).
 *
 * Existe para que un deep-link escrito a mano caiga donde corresponde en vez de dar 404. El
 * `redirect()` va acá, fuera de toda transacción.
 */
export default async function BarrioSinSeccion({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio } = await params;
  if (!esIdValido(barrio)) notFound();
  redirect(`/${barrio}/tablero`);
}
