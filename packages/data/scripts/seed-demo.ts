/**
 * Modo demo: carga un barrio realista para mostrarle el sistema a un administrador — y de paso sirve
 * de fixture para las pruebas manuales.
 *
 * **Datos ficticios**: nombres inventados, sin PII real (regla del proyecto). Idempotente: si ya
 * existe el barrio demo, lo borra y lo vuelve a crear.
 *
 * Uso: `pnpm db:seed` (después de `pnpm db:migrate && pnpm db:setup`).
 */
import pg from "pg";
import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aCentavos, prorratear, sumarMontos } from "@admin-barrios/shared/dinero";
import { sugerirDenominacionConcepto } from "@admin-barrios/shared/barrio";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Falta DATABASE_URL (ver .env.example)");
if (process.env["NODE_ENV"] === "production") throw new Error("el seed de demo no corre en producción");

const ADMINISTRADOR = "Estudio Demo — Administración";
const BARRIO = "Barrio Demo Los Aromos";
const CANTIDAD_UNIDADES = 50;
/** Gasto del período que se reparte por coeficiente, solo para mostrar cifras creíbles. */
const GASTO_DEL_PERIODO = "9875430.00";

const NOMBRES = [
  "Ana", "Bruno", "Carla", "Diego", "Elena", "Franco", "Gabriela", "Hugo", "Irene", "Julián",
  "Karina", "Lucas", "Marta", "Nicolás", "Olivia", "Pablo", "Rocío", "Santiago", "Tamara", "Valentín",
] as const;
const APELLIDOS = [
  "Gómez", "Fernández", "López", "Martínez", "Sosa", "Ramírez", "Quiroga", "Ferreyra", "Peralta", "Bustos",
] as const;

const cliente = new pg.Client({ connectionString: url });
await cliente.connect();

try {
  await cliente.query("begin");

  // --- Limpieza del demo anterior (idempotencia) --------------------------------------------
  const { rows: previos } = await cliente.query<{ id: string; path: string }>(
    "select id, path from tenant_node where nombre = $1 and tipo = 'administrador'",
    [ADMINISTRADOR],
  );
  for (const previo of previos) {
    const { rows: nodos } = await cliente.query<{ id: string }>(
      "select id from tenant_node where path = $1 or path like $1 || '.%' order by path desc",
      [previo.path],
    );
    const ids = nodos.map((n) => n.id);
    for (const tabla of [
      "coeficiente", "coeficiente_version", "unidad_obligado", "unidad_contacto", "obligado",
      "unidad_funcional", "mandato_administracion", "barrio_atributo_vigencia", "documento_barrio", "barrio",
    ]) {
      await cliente.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [ids]);
    }
    await cliente.query("delete from membership where tenant_node_id = any($1::uuid[])", [ids]);
    for (const id of ids) await cliente.query("delete from tenant_node where id = $1", [id]);
  }

  // --- Tenancía: administrador → barrio ------------------------------------------------------
  const { rows: adminRows } = await cliente.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre) values ('administrador', $1) returning id",
    [ADMINISTRADOR],
  );
  const administradorId = adminRows[0]?.id;
  if (!administradorId) throw new Error("no se pudo crear el administrador demo");

  const { rows: barrioRows } = await cliente.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id",
    [BARRIO, administradorId],
  );
  const barrioId = barrioRows[0]?.id;
  if (!barrioId) throw new Error("no se pudo crear el barrio demo");

  // Usuario demo con acceso a todo el estudio (el id sale de la capa de Auth; acá es fijo y ficticio).
  const usuarioDemo = "00000000-0000-4000-8000-000000000001";
  await cliente.query(
    "insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'admin_barrio')",
    [usuarioDemo, administradorId],
  );

  // --- Barrio: PH especial en trámite de adecuación, en Villa Allende -----------------------
  const figura = "ph_especial";
  const denominacion = sugerirDenominacionConcepto(figura)?.denominacion ?? null;
  await cliente.query(
    `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
                         servicios_internos_a_cargo_de, titularidad_espacios_comunes, denominacion_concepto,
                         reglamento_inscripto, pacto_ejecutividad, tiene_espacios_comunes_exclusivos,
                         tiene_consejo, tiene_fondo_reserva, domicilio_sede)
     values ($1,$2,'en_tramite','ure','villa-allende','urbanizacion','propietarios',$3,
             true, null, true, true, true, 'Ruta E-53 km 12, Villa Allende, Córdoba')`,
    [barrioId, figura, denominacion],
  );

  await cliente.query(
    `insert into mandato_administracion (barrio_id, administrador_id, desde, notas)
     values ($1,$2, current_date - 365, 'Designado por asamblea ordinaria (acta de ejemplo)')`,
    [barrioId, administradorId],
  );

  // --- Padrón: 50 unidades, con baldías y en construcción ------------------------------------
  const unidades: Array<{ id: string; etiqueta: string; superficie: number }> = [];
  for (let i = 0; i < CANTIDAD_UNIDADES; i++) {
    const manzana = String(Math.floor(i / 10) + 1);
    const lote = String((i % 10) + 1);
    // ~14% baldías y ~10% en construcción: generan expensas igual (art. 2077).
    const estado = i % 7 === 0 ? "baldio" : i % 10 === 3 ? "en_construccion" : "construido";
    const superficie = 450 + ((i * 37) % 550); // 450–1000 m2, determinístico
    const { rows } = await cliente.query<{ id: string }>(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2, nomenclatura_catastral)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [barrioId, manzana, lote, estado, superficie.toFixed(2), `13-01-45-${manzana.padStart(2, "0")}-${lote.padStart(3, "0")}`],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("no se pudo crear la unidad demo");
    unidades.push({ id, etiqueta: `MZ ${manzana} — LOTE ${lote}`, superficie });

    // Obligado (propietario) + contacto.
    const nombre = `${NOMBRES[i % NOMBRES.length]} ${APELLIDOS[i % APELLIDOS.length]}`;
    const { rows: oblRows } = await cliente.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, email, telefono)
       values ($1,$2,'DNI',$3,$4,$5) returning id`,
      [barrioId, nombre, String(20_000_000 + i * 13_577), `demo${i + 1}@ejemplo.test`, `+54 351 555-${String(1000 + i)}`],
    );
    const obligadoId = oblRows[0]?.id;
    await cliente.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1,$2,$3,'propietario', current_date - 400, true)`,
      [barrioId, id, obligadoId],
    );
    await cliente.query(
      `insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre, principal)
       values ($1,$2,$3,$4,true)`,
      [barrioId, id, `demo${i + 1}@ejemplo.test`, nombre],
    );

    // Una de cada diez tiene además un poseedor: el propietario NO se libera (art. 2050).
    if (i % 10 === 5) {
      const { rows: pos } = await cliente.query<{ id: string }>(
        `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento)
         values ($1,$2,'DNI',$3) returning id`,
        [barrioId, `${NOMBRES[(i + 3) % NOMBRES.length]} ${APELLIDOS[(i + 5) % APELLIDOS.length]}`, String(30_000_000 + i * 7_919)],
      );
      await cliente.query(
        `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde)
         values ($1,$2,$3,'poseedor', current_date - 200)`,
        [barrioId, id, pos[0]?.id],
      );
    }
  }

  // --- Coeficientes por superficie, normalizados a 1 y CERRADOS ------------------------------
  const { rows: verRows } = await cliente.query<{ id: string }>(
    `insert into coeficiente_version (barrio_id, base, descripcion, vigente_desde)
     values ($1,'parte_indivisa','Coeficientes del reglamento (demo, proporcionales a superficie)', current_date - 365)
     returning id`,
    [barrioId],
  );
  const versionId = verRows[0]?.id;
  if (!versionId) throw new Error("no se pudo crear la versión de coeficientes");

  // Se reparte 1 entre las unidades según superficie, con el resto a la última: la suma cierra exacta
  // (es el mismo helper que usa la liquidación, así el demo prueba el camino real).
  //
  // Se prorratea sobre 10.000.000,00 = 1e9 centavos para obtener los 9 decimales del coeficiente:
  // repartir "1.00" daría solo 2 decimales y todas las unidades quedarían iguales.
  const ESCALA_CENTAVOS = 1_000_000_000n;
  const partes = prorratear(
    "10000000.00",
    unidades.map((u) => [u.id, String(u.superficie)] as const),
  );
  for (const [unidadId, monto] of partes) {
    const centavos = aCentavos(monto);
    const valor = `0.${(centavos * 1_000_000_000n / ESCALA_CENTAVOS).toString().padStart(9, "0")}`;
    await cliente.query(
      `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,$4)`,
      [barrioId, versionId, unidadId, valor],
    );
  }
  await cliente.query("update coeficiente_version set cerrada = true where id = $1", [versionId]);

  // --- Documentos del barrio (datos de primera clase) ----------------------------------------
  await cliente.query(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento, inscripto, notas)
     values ($1,'reglamento','Reglamento de propiedad horizontal (demo)', current_date - 3000, true,
             'Documento de ejemplo: no hay archivo cargado en el almacenamiento')`,
    [barrioId],
  );
  await cliente.query(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento, notas)
     values ($1,'acta_designacion_administrador','Acta de designación del administrador (demo)', current_date - 365,
             'Documento de ejemplo')`,
    [barrioId],
  );

  await cliente.query("commit");

  // --- Resumen para la consola ---------------------------------------------------------------
  const cargos = prorratear(
    GASTO_DEL_PERIODO,
    unidades.map((u) => [u.id, String(u.superficie)] as const),
  );
  const total = sumarMontos(...cargos.map(([, monto]) => monto));
  const { rows: baldias } = await cliente.query<{ n: string }>(
    "select count(*)::text as n from unidad_funcional where barrio_id = $1 and estado_unidad <> 'construido'",
    [barrioId],
  );

  console.log(`Modo demo listo:
  Administrador : ${ADMINISTRADOR}
  Barrio        : ${BARRIO} (PH especial, adecuación en trámite, Villa Allende)
  Unidades      : ${unidades.length} (${baldias[0]?.n} baldías o en construcción — generan expensas igual)
  Coeficientes  : versión cerrada, suma exacta = 1
  Usuario demo  : ${usuarioDemo} (admin_barrio sobre todo el estudio)

  Prorrateo de ejemplo sobre $ ${GASTO_DEL_PERIODO}: la suma de las 50 partes da $ ${total}.`);
} catch (error) {
  await cliente.query("rollback");
  throw error;
} finally {
  await cliente.end();
}
