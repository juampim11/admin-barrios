/**
 * Herramienta de verificación (no es código de producto): encola la emisión de documentos del último
 * período emitido, con la identidad del administrador de la demo, y muestra cómo queda.
 *
 * Sirve para ejercitar el camino completo sin abrir el navegador: el trigger que deriva el barrio, la
 * policy de `insert`, el `pg_notify` y el worker levantándolo.
 *
 *   node packages/data/scripts/encolar-documentos.ts
 */

import pg from "pg";
import { sql } from "drizzle-orm";
import { config as cargarEnv } from "dotenv";
import { resolve } from "node:path";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";
import { conUsuario, crearDbMantenimiento } from "../src/client.ts";
import { encolarEmisionDeDocumentos } from "../src/servicios/trabajos.ts";

cargarEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Falta DATABASE_URL");
// Mismo cerrojo que `demo:boleta`: este script se conecta como dueño del esquema y encola con la
// identidad de un usuario **escrito a mano acá**. Fuera de una máquina de desarrollo eso no existe.
exigirEntornoLocal("el encolado de documentos de prueba");

const ADMIN_DEMO = "00000000-0000-4000-8000-000000000001";

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const db = crearDbMantenimiento(pool);

  const periodo = await conUsuario(db, ADMIN_DEMO, async (tx) => {
    const fila = (
      await tx.execute<{ id: string; periodo: string }>(sql`
        select id, periodo from periodo_expensa
         where estado in ('emitida', 'distribuida')
         order by periodo desc limit 1
      `)
    ).rows[0];
    if (!fila) throw new Error("no hay ningún período emitido: corré `pnpm db:seed`");
    return fila;
  });

  const trabajo = await conUsuario(db, ADMIN_DEMO, (tx) =>
    encolarEmisionDeDocumentos(tx, { periodoId: periodo.id }),
  );

  console.log(`Encolado para ${periodo.periodo}: trabajo ${trabajo.id} (${trabajo.estado})`);
} finally {
  await pool.end();
}
