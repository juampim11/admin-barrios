/**
 * Hook `register()` de Next: corre **al levantar el servidor**, antes del primer request.
 *
 * Sin este archivo, el candado del ADR-0002 §2.4 vuelta 1 no se cumple, y conviene entender por qué
 * antes de borrarlo por "no hace nada":
 *
 * Next carga los módulos de ruta **perezosamente**. Un `throw` de módulo en `servidor/db.ts`
 * aparecería recién en el primer request que toque una ruta que lo importe — como un 500, con el
 * contenedor **sano** para el orquestador, el health-check en verde y el despliegue dado por bueno.
 * O sea: un despliegue mal configurado quedaría "andando" hasta que alguien entrara.
 *
 * Con esto, un proceso que no puede establecer identidad, o que recibió una credencial que no le
 * toca, o que tiene el elenco de la demo cargado fuera de `local`, **no llega a atender**.
 *
 * `runtime === "nodejs"`: el edge runtime no tiene `pg` y no atiende nada de esto.
 */

export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  // Import dinámico a propósito: cargar el módulo del pool es justamente lo que dispara la
  // validación de configuración y la creación del provider, y queremos que eso pase acá adentro.
  const { verificarArranque } = await import("./servidor/db.ts");
  await verificarArranque();
}
