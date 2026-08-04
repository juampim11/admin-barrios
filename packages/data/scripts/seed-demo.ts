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
import { sql } from "drizzle-orm";
import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";
import { aCentavos, prorratear } from "@admin-barrios/shared/dinero";
import { sugerirDenominacionConcepto } from "@admin-barrios/shared/barrio";
import { conUsuario, crearDbMantenimiento } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { aplicarConceptoAUnidad } from "../src/servicios/cargos.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Falta DATABASE_URL (ver .env.example)");
exigirEntornoLocal("el seed de demo");

const ADMINISTRADOR = "Estudio Demo — Administración";
const BARRIO = "Barrio Demo Los Aromos";
const BARRIO_SECUNDARIO = "Barrio Demo Las Cortaderas";

/**
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL TERCER BARRIO: CUOTA FIJA, A ESCALA REAL
 *
 * Los otros dos prorratean por coeficiente. Este cobra **una cuota igual para todas las unidades**,
 * que es la forma típica de un loteo organizado como **SA** —un lote, una acción, una cuota— y la
 * otra mitad del mercado frente al PH. Hasta acá el modelo `fija` existía en el motor y **nunca se
 * había visto en pantalla**: sembrarlo hace que la demo sirva además de prueba.
 *
 * **La traza es la del barrio piloto: 510 lotes en 24 manzanas.** Manzana y lote son la geometría del
 * barrio, no un dato de nadie; los nombres, documentos y correos son **inventados**. Es la regla que
 * el propio repo ya tenía escrita en `_referencias/LEEME.txt` — se conserva la estructura, nunca las
 * personas — y por eso este archivo **no lee `_referencias/`**: los datos están acá, a la vista.
 *
 * El nombre del barrio es ficticio por ADR-0001 §1: el producto es white-label y multi-cliente, y
 * *"nada de «Las Corzuelas» en el código"*. Para una demostración con la administración real hay un
 * cargador aparte, fuera del repositorio.
 *
 * Y 510 unidades no es un capricho de realismo: el techo de página de la pantalla del período es 500,
 * así que **este barrio es el único que activa el paginado** y la nota que declara que los totales
 * son de la página y no del mes.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
const BARRIO_CUOTA_FIJA = "Barrio Demo Los Talas";

/**
 * Manzana → lotes. Un número significa `1..n` correlativo; un arreglo, los lotes que existen de
 * verdad (hay manzanas con huecos, porque los lotes se vendieron y se unificaron con los años).
 */
const TRAZA: Readonly<Record<string, number | readonly number[]>> = {
  "60": [4, 5, 6, 7],
  "61": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  "62": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  "63": 26,
  "64": 17,
  "65": 33,
  "66": 39,
  "67": [1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
  "68": 23,
  "70": 29,
  "71": 21,
  "72": 21,
  "73": 19,
  "74": 30,
  "75": 17,
  "76": 27,
  "77": 32,
  "78": 14,
  "79": 18,
  "80": 28,
  "81": 24,
  "82": 22,
  "83": 10,
  "84": 9,
};

/**
 * La cuota mensual, igual para todas las unidades.
 *
 * **No sale de dividir los gastos**: la fija el directorio y el sistema no la deduce ni la sugiere.
 * Que el gasto del mes no coincida con lo recaudado es lo normal en este modelo, y es justamente el
 * número que la pantalla tiene que poner a la vista (requisito C-10).
 */
const CUOTA_MENSUAL = "382000.00";

/**
 * Los conceptos de gasto de un barrio de esta escala, con su orden de magnitud real.
 *
 * **Sin nombres de proveedores ni de empleados**: el rubro es el dato útil ("Personal de
 * mantenimiento"), la razón social de quién lo presta no es información nuestra para publicar.
 */
const GASTOS_DEL_MES: ReadonlyArray<readonly [string, string, "ordinaria" | "extraordinaria"]> = [
  ["Seguridad privada", "91206999.58", "ordinaria"],
  ["Mantenimiento y jardinería de áreas verdes", "20482434.19", "ordinaria"],
  ["Recolección de residuos urbanos", "11492737.26", "ordinaria"],
  ["Adicional de policía (20 a 08 h)", "7833351.72", "ordinaria"],
  ["Personal de mantenimiento", "6699584.90", "ordinaria"],
  ["Energía eléctrica de espacios comunes", "5001441.80", "ordinaria"],
  ["Honorarios de intendencia", "3540000.00", "ordinaria"],
  ["Honorarios de administración", "3125000.00", "ordinaria"],
  ["Comisiones de medios de pago", "2865957.73", "ordinaria"],
  ["Impuesto Ley 25.413", "2020202.10", "ordinaria"],
  ["Cámaras: service mensual y reparaciones", "1950000.00", "ordinaria"],
  ["Honorarios legales", "1580687.16", "ordinaria"],
  ["Reparación de luminarias", "1490826.00", "ordinaria"],
  ["Reciclado de residuos", "1431056.10", "ordinaria"],
];

/**
 * El id del administrador demo es **fijo**, como los del elenco.
 *
 * Antes la limpieza buscaba el demo anterior **por nombre**, y eso se rompió el 2026-08-04 de la
 * forma más silenciosa posible: al reparar los acentos, `ADMINISTRADOR` pasó de tener el nombre roto
 * al correcto, la búsqueda no encontró nada, y `pnpm db:seed` **sembró un juego entero encima del
 * anterior**. El resultado se vio en la pantalla del administrador: dos barrios con el mismo nombre,
 * uno de ellos con los acentos rotos de la corrida vieja.
 *
 * Con un id fijo, la limpieza no depende de ningún texto: cambiar el nombre del estudio, o cualquier
 * otra cosa que se muestre, deja de poder duplicar el demo. Es la misma razón por la que los
 * usuarios del elenco ya tenían ids fijos.
 */
const ADMINISTRADOR_ID = "00000000-0000-4000-9000-000000000001";
const CANTIDAD_UNIDADES = 50;
const CANTIDAD_UNIDADES_SECUNDARIO = 12;

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
  // Por **id fijo**, y además por prefijo de nombre para barrer los demos que se sembraron antes de
  // que el id fuera fijo (los que quedaron duplicados el 2026-08-04). Lo segundo es un barrido de
  // una vez que no molesta: este script solo corre en `local` —lo verifica `exigirEntornoLocal`— y
  // ahí no hay ningún estudio de verdad que se llame "Estudio Demo".
  const { rows: previos } = await cliente.query<{ id: string; path: string }>(
    "select id, path from tenant_node where tipo = 'administrador' and (id = $1 or nombre like 'Estudio Demo%')",
    [ADMINISTRADOR_ID],
  );
  for (const previo of previos) {
    const { rows: nodos } = await cliente.query<{ id: string }>(
      "select id from tenant_node where path = $1 or path like $1 || '.%' order by path desc",
      [previo.path],
    );
    const ids = nodos.map((n) => n.id);
    // El demo anterior puede tener un período EMITIDO, que es inmutable a propósito. Para volver a
    // sembrar se entra por la puerta de mantenimiento (desactiva triggers; solo superusuario).
    await cliente.query("set session_replication_role = replica");
    for (const tabla of [
      // Las tres de la emisión van PRIMERO, y tienen que estar en esta lista aunque sean
      // append-only: `session_replication_role = replica` apaga también las claves foráneas, así que
      // sin ellas el barrio se borra igual y **quedan documentos apuntando a un barrio que ya no
      // existe** — en silencio, acumulándose en cada `pnpm db:seed`.
      "descarga_documento", "documento_emitido", "trabajo",
      "concepto_boleta_unidad_evento", "item_liquidacion", "liquidacion", "concepto_boleta_unidad",
      "concepto_boleta_valor", "concepto_boleta", "limite_aplicacion_barrio",
      // `cuota_fija` va ANTES que `periodo_expensa` (que referencia a su versión) y `cuota_fija_version`
      // después. Faltaban las dos: con las claves foráneas apagadas el barrio se borraba igual y
      // quedaban cuotas colgando de unidades inexistentes — exactamente el modo de falla que este
      // bloque venía advirtiendo para las tablas de la emisión.
      "gasto_periodo", "cuota_fija", "periodo_expensa", "cuota_fija_version", "concepto", "tasa_mora",
      "coeficiente", "coeficiente_version", "unidad_obligado", "unidad_contacto", "obligado",
      "unidad_funcional", "mandato_administracion", "barrio_atributo_vigencia", "documento_barrio", "barrio",
    ]) {
      await cliente.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [ids]);
    }
    await cliente.query("delete from membership where tenant_node_id = any($1::uuid[])", [ids]);
    for (const id of ids) await cliente.query("delete from tenant_node where id = $1", [id]);
    await cliente.query("set session_replication_role = origin");
  }

  // --- Tenancía: administrador → barrio ------------------------------------------------------
  const { rows: adminRows } = await cliente.query<{ id: string }>(
    "insert into tenant_node (id, tipo, nombre) values ($1, 'administrador', $2) returning id",
    [ADMINISTRADOR_ID, ADMINISTRADOR],
  );
  const administradorId = adminRows[0]?.id;
  if (!administradorId) throw new Error("no se pudo crear el administrador demo");

  const { rows: barrioRows } = await cliente.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id",
    [BARRIO, administradorId],
  );
  const barrioId = barrioRows[0]?.id;
  if (!barrioId) throw new Error("no se pudo crear el barrio demo");

  // --- Elenco de la demo: con qué usuarios se puede entrar ------------------------------------
  //
  // Los ids son fijos y ficticios (salen de la capa de Auth; acá no hay tabla de usuarios todavía).
  // Cada uno tiene DOS filas: una en `membership` —que es lo que la RLS mira— y una en
  // `usuario_demo`, que es la lista que la pantalla de entrada ofrece (ADR-0002 §2.3).
  //
  // ⚠ PRECONDICIÓN DE SEGURIDAD, no un recorte de alcance (ADR-0002 §3.5): **ninguna membresía con
  // rol `propietario` ni `residente`**. Dentro de un barrio, la RLS de 0018 le da a todo rol de
  // GESTIÓN el padrón completo; el día que alguien siembre un `propietario` "para ver cómo se ve",
  // no ve lo suyo: no ve nada, o —si mañana se abriera la policy sin el vínculo usuario→unidad— ve
  // el barrio entero. Hasta que exista `usuario_unidad`, acá solo hay roles de gestión. Hay un test
  // del proyecto `db` que falla el gate si esta línea se afloja.
  const usuarioDemo = "00000000-0000-4000-8000-000000000001";
  const operadorDemo = "00000000-0000-4000-8000-000000000002";
  const elenco: Array<{
    id: string;
    email: string;
    nombre: string;
    descripcion: string;
    nodo: string;
    rol: "admin_barrio" | "operador" | "contador" | "auditor";
  }> = [
    {
      id: usuarioDemo,
      email: "admin@estudio.test",
      nombre: "Valeria Ríos",
      descripcion: "Administradora del estudio — ve todos los barrios que administra",
      nodo: administradorId,
      rol: "admin_barrio",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      email: "operador@estudio.test",
      nombre: "Martín Coria",
      descripcion: `Operador de ${BARRIO} — carga gastos y aplica cargos, solo en ese barrio`,
      nodo: barrioId,
      rol: "operador",
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      email: "contador@estudio.test",
      nombre: "Silvia Aguirre",
      descripcion: `Contadora de ${BARRIO} — solo lectura: no emite ni carga`,
      nodo: barrioId,
      rol: "contador",
    },
  ];

  for (const persona of elenco) {
    await cliente.query("insert into membership (user_id, tenant_node_id, rol) values ($1, $2, $3)", [
      persona.id,
      persona.nodo,
      persona.rol,
    ]);
    // `usuario_demo` no tiene grant de escritura para NINGÚN rol de la app: esta línea solo funciona
    // porque el seed se conecta como dueño del esquema. Es exactamente el candado del §2.4 vuelta 3.
    await cliente.query(
      `insert into usuario_demo (user_id, email, nombre, descripcion) values ($1,$2,$3,$4)
       on conflict (user_id) do update
         set email = excluded.email, nombre = excluded.nombre, descripcion = excluded.descripcion`,
      [persona.id, persona.email, persona.nombre, persona.descripcion],
    );
  }

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

  // --- Conceptos, tasa de mora y un período liquidado de punta a punta ----------------------
  const { rows: actaRows } = await cliente.query<{ id: string }>(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento, notas)
     values ($1,'acta_asamblea','Acta de asamblea que aprueba el portón nuevo (demo)', current_date - 60,
             'Documento de ejemplo') returning id`,
    [barrioId],
  );
  const actaId = actaRows[0]?.id;

  const crearConcepto = async (nombre: string, tipo: string, fondo = false, fiscal = "sin_clasificar") => {
    const { rows } = await cliente.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, es_fondo_reserva, clasificacion_fiscal)
       values ($1,$2,$3,$4,$5) returning id`,
      [barrioId, nombre, tipo, fondo, fiscal],
    );
    return rows[0]?.id as string;
  };
  const cSeguridad = await crearConcepto("Seguridad y vigilancia", "ordinaria");
  const cEspaciosVerdes = await crearConcepto("Mantenimiento de espacios verdes", "ordinaria");
  const cAdministracion = await crearConcepto("Honorarios de administración", "ordinaria");
  const cFondo = await crearConcepto("Fondo de reserva", "ordinaria", true);
  const cPorton = await crearConcepto("Portón de acceso (obra)", "extraordinaria");

  // Tasa de mora del reglamento: sin esto, la liquidación saldría marcada como pendiente de definir.
  await cliente.query(
    `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.030000, current_date - 365)`,
    [barrioId],
  );

  const hoy = new Date();
  const mesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const periodo = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, "0")}`;
  const { rows: perRows } = await cliente.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, primer_vencimiento, segundo_vencimiento, notas)
     values ($1,$2, current_date + 10, current_date + 20, 'Período de demostración') returning id`,
    [barrioId, periodo],
  );
  const periodoId = perRows[0]?.id;
  if (!periodoId) throw new Error("no se pudo crear el período demo");

  const gastos: Array<[string, string, string, string | null]> = [
    [cSeguridad, "Servicio de vigilancia 24 h", "5480000.00", null],
    [cEspaciosVerdes, "Corte de césped y poda", "1260500.00", null],
    [cAdministracion, "Honorarios del período", "985000.00", null],
    [cFondo, "Aporte al fondo de reserva", "620000.00", null],
    [cPorton, "Portón de acceso — 1ª cuota (asamblea)", "1530000.00", actaId ?? null],
  ];
  for (const [conceptoId, descripcion, monto, acta] of gastos) {
    await cliente.query(
      `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, acta_documento_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [barrioId, periodoId, conceptoId, descripcion, monto, acta],
    );
  }

  // --- Cargos y descuentos de boleta ----------------------------------------------------------
  // El "vecino cumplidor" con financiamiento `partida_presupuestada`: el presupuesto se armó sobre la
  // expensa CON el descuento aplicado, así que el barrio no pone nada de su bolsillo (doc 08 §J).
  // El quincho es un cargo de uso: no reparte gasto común, se le cobra a quien lo usó.
  const conceptosBoleta: Array<{
    nombre: string;
    clase: "cargo" | "descuento";
    metodo: "monto_fijo" | "porcentaje" | "precio_x_cantidad";
    base: "expensa_ordinaria" | "sin_base";
    financiamiento: string | null;
    monto: string | null;
    porcentaje: string | null;
    precio: string | null;
    tope: string | null;
  }> = [
    {
      nombre: "Bonificación vecino cumplidor",
      clase: "descuento", metodo: "porcentaje", base: "expensa_ordinaria",
      financiamiento: "partida_presupuestada",
      monto: null, porcentaje: "10.000000", precio: null, tope: "35000.00",
    },
    {
      nombre: "Alquiler de quincho",
      clase: "cargo", metodo: "precio_x_cantidad", base: "sin_base", financiamiento: null,
      monto: null, porcentaje: null, precio: "38000.00", tope: null,
    },
  ];
  const catalogoBoleta = new Map<string, { conceptoId: string; valorId: string }>();
  for (const c of conceptosBoleta) {
    const { rows: cRows } = await cliente.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento)
       values ($1,$2,$3,$4,$5,'sin_clasificar',$6) returning id`,
      [barrioId, c.nombre, c.clase, c.metodo, c.base, c.financiamiento],
    );
    const conceptoId = cRows[0]?.id;
    if (!conceptoId) throw new Error(`no se pudo crear el concepto de boleta ${c.nombre}`);
    const { rows: vRows } = await cliente.query<{ id: string }>(
      `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje,
                                          precio_unitario, tope, vigente_desde)
       values ($1,$2,$3,$4,$5,$6,$7, current_date - 60) returning id`,
      [barrioId, conceptoId, c.metodo, c.monto, c.porcentaje, c.precio, c.tope],
    );
    const valorId = vRows[0]?.id;
    if (!valorId) throw new Error(`no se pudo crear el valor de ${c.nombre}`);
    catalogoBoleta.set(c.nombre, { conceptoId, valorId });
  }

  // Hasta dónde puede llegar un `operador` aplicando descuentos, sin pedirle a un administrador.
  //
  // Sin esta fila, `app.cbu_antes()` **falla cerrado** y el operador de la demo no puede aplicar ni
  // un descuento: el mensaje sería oscuro y la pantalla de cargos, inservible. Es el hueco que el
  // ADR-0002 §7.3 dejó anotado ("no se inserta desde ningún lado — ni el seed la escribe") y que se
  // descubría en la demo. Los valores son de demostración: cuánto es razonable es una decisión de
  // `administrador-consorcios` por barrio (ADR-0002 §12), no un default del producto.
  //
  // `monto_max_cargo_operador` es el mismo mecanismo del lado de los CARGOS (migración 0025): por
  // unidad y período, **acumulado**. Sin esta columna el operador de la demo tampoco puede aplicar un
  // quincho, porque el cargo también falla cerrado desde 0025. $120.000 deja pasar un par de reservas
  // reales ($38.000 cada una) y frena la repetición que llegó a emitir una boleta de $3.100.000.
  //
  // `multiplo_confirmacion_cargo` va en NULL a propósito: la demo corre con el default del sistema
  // (3 veces la expensa de la unidad), que es el que va a ver un barrio recién dado de alta.
  await cliente.query(
    `insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador,
                                           monto_max_cargo_operador, multiplo_confirmacion_cargo,
                                           vigente_desde)
     values ($1, '40000.00', 15.000000, '120000.00', null, current_date - 365)`,
    [barrioId],
  );

  // Bonificación a 3 de cada 4 unidades (la mayoría paga en término) y quincho a dos vecinos.
  const bonificados = unidades.filter((_, i) => i % 4 !== 0);
  const conQuincho = unidades.slice(0, 2);
  const aplicaciones: Array<[string, string, Record<string, string | null>]> = [
    ...bonificados.map(
      (u) =>
        ["Bonificación vecino cumplidor", u.id, {
          clase: "descuento", metodo: "porcentaje", base: "expensa_ordinaria",
          monto: null, porcentaje: "10.000000", precio: null, cantidad: null, tope: "35000.00",
          detalle: "Pagó en término las últimas 6 expensas",
        }] as [string, string, Record<string, string | null>],
    ),
    ...conQuincho.map(
      (u) =>
        ["Alquiler de quincho", u.id, {
          clase: "cargo", metodo: "precio_x_cantidad", base: "sin_base",
          monto: null, porcentaje: null, precio: "38000.00", cantidad: "1", tope: null,
          detalle: "Reserva del quincho — 1 jornada",
        }] as [string, string, Record<string, string | null>],
    ),
  ];
  // --- Un segundo período, EN BORRADOR ---------------------------------------------------------
  //
  // El período emitido de arriba demuestra el resultado; **este demuestra el trabajo**. Sin un
  // borrador, las pantallas de carga (gastos, cargos y descuentos, generar el borrador, emitir) no se
  // pueden probar ni mostrar: todo lo que existía estaba congelado por `app.periodo_editable`.
  //
  // Queda a propósito **sin liquidaciones generadas**: que "Generar el borrador" tenga algo que hacer
  // es parte de lo que hay que poder mostrar.
  const mesEnCurso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const { rows: borrRows } = await cliente.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, primer_vencimiento, segundo_vencimiento, notas)
     values ($1,$2, current_date + 40, current_date + 50,
             'Período en curso: gastos cargándose, todavía sin liquidar') returning id`,
    [barrioId, mesEnCurso],
  );
  const periodoBorradorId = borrRows[0]?.id;
  if (!periodoBorradorId) throw new Error("no se pudo crear el período en borrador");

  // Menos gastos que el emitido, y a propósito: es un mes a medio cargar, que es como se ve de verdad.
  // La extraordinaria va **sin acta**: el trigger la marca `sin_respaldo_asamblea` y la pantalla tiene
  // que mostrar esa marca (doc 08 §A.0 punto 2). Es el caso que no se puede ver en el período emitido.
  for (const [conceptoId, descripcion, monto, acta] of [
    [cSeguridad, "Servicio de vigilancia 24 h", "5480000.00", null],
    [cEspaciosVerdes, "Corte de césped (primera quincena)", "630250.00", null],
    [cPorton, "Reparación de urgencia del portón (sin asamblea previa)", "410000.00", null],
  ] as Array<[string, string, string, string | null]>) {
    await cliente.query(
      `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, acta_documento_id,
                                  proveedor_nombre, comprobante)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [barrioId, periodoBorradorId, conceptoId, descripcion, monto, acta, "Proveedor de ejemplo S.A.", "FC-B-0001-00012345"],
    );
  }


  // --- Segundo barrio: fixture de navegacion y aislamiento -----------------------------------
  // No tiene periodos a proposito: sirve para probar el selector de barrio y los estados vacios sin
  // duplicar todo el recorrido de liquidacion. La membresia del administrador esta en el nodo padre,
  // asi que hereda este barrio; el operador conserva membresia directa solo en Los Aromos.
  const { rows: barrio2Rows } = await cliente.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id",
    [BARRIO_SECUNDARIO, administradorId],
  );
  const barrioSecundarioId = barrio2Rows[0]?.id;
  if (!barrioSecundarioId) throw new Error("no se pudo crear el segundo barrio demo");

  const figuraSecundaria = "sa";
  const denominacionSecundaria = sugerirDenominacionConcepto(figuraSecundaria)?.denominacion ?? null;
  await cliente.query(
    `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
                         servicios_internos_a_cargo_de, titularidad_espacios_comunes, denominacion_concepto,
                         reglamento_inscripto, pacto_ejecutividad, tiene_espacios_comunes_exclusivos,
                         tiene_consejo, tiene_fondo_reserva, domicilio_sede)
     values ($1,$2,'no_aplica','loteo_abierto','mendiolaza','mixto','ente',$3,
             true, null, false, false, true, 'Camino a El Talar km 4, Mendiolaza, Córdoba')`,
    [barrioSecundarioId, figuraSecundaria, denominacionSecundaria],
  );
  await cliente.query(
    `insert into mandato_administracion (barrio_id, administrador_id, desde, notas)
     values ($1,$2, current_date - 180, 'Mandato de administracion de ejemplo para segundo barrio')`,
    [barrioSecundarioId, administradorId],
  );

  const unidadesSecundarias: Array<{ id: string; superficie: number }> = [];
  for (let i = 0; i < CANTIDAD_UNIDADES_SECUNDARIO; i++) {
    const lote = String(i + 1);
    const superficie = 600 + ((i * 53) % 320);
    const estado = i % 6 === 0 ? "baldio" : "construido";
    const { rows } = await cliente.query<{ id: string }>(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2, nomenclatura_catastral)
       values ($1,'A',$2,$3,$4,$5) returning id`,
      [barrioSecundarioId, lote, estado, superficie.toFixed(2), `14-02-10-A-${lote.padStart(3, "0")}`],
    );
    const unidadId = rows[0]?.id;
    if (!unidadId) throw new Error("no se pudo crear una unidad del segundo barrio demo");
    unidadesSecundarias.push({ id: unidadId, superficie });

    const nombre = `${NOMBRES[(i + 7) % NOMBRES.length]} ${APELLIDOS[(i + 4) % APELLIDOS.length]}`;
    const { rows: oblRows } = await cliente.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, email, telefono)
       values ($1,$2,'DNI',$3,$4,$5) returning id`,
      [barrioSecundarioId, nombre, String(24_000_000 + i * 11_003), `cortaderas${i + 1}@ejemplo.test`, `+54 351 556-${String(2000 + i)}`],
    );
    const obligadoId = oblRows[0]?.id;
    await cliente.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1,$2,$3,'propietario', current_date - 240, true)`,
      [barrioSecundarioId, unidadId, obligadoId],
    );
  }

  const { rows: version2Rows } = await cliente.query<{ id: string }>(
    `insert into coeficiente_version (barrio_id, base, descripcion, vigente_desde)
     values ($1,'superficie','Coeficientes demo por superficie para selector multi-barrio', current_date - 180)
     returning id`,
    [barrioSecundarioId],
  );
  const versionSecundariaId = version2Rows[0]?.id;
  if (!versionSecundariaId) throw new Error("no se pudo crear la version de coeficientes del segundo barrio");
  const partesSecundarias = prorratear(
    "10000000.00",
    unidadesSecundarias.map((u) => [u.id, String(u.superficie)] as const),
  );
  for (const [unidadId, monto] of partesSecundarias) {
    const centavos = aCentavos(monto);
    const valor = `0.${(centavos * 1_000_000_000n / ESCALA_CENTAVOS).toString().padStart(9, "0")}`;
    await cliente.query(
      `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,$4)`,
      [barrioSecundarioId, versionSecundariaId, unidadId, valor],
    );
  }
  await cliente.query("update coeficiente_version set cerrada = true where id = $1", [versionSecundariaId]);
  await cliente.query(
    `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.025000, current_date - 180)`,
    [barrioSecundarioId],
  );
  await cliente.query(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento, notas)
     values ($1,'estatuto','Estatuto social (demo)', current_date - 2500, 'Documento de ejemplo')`,
    [barrioSecundarioId],
  );


  // --- Tercer barrio: cuota fija, a escala real ----------------------------------------------
  //
  // El único de los tres que NO prorratea. Ver la nota de `BARRIO_CUOTA_FIJA` arriba: traza real,
  // personas inventadas, y 510 unidades para que el paginado del período deje de ser teoría.
  const { rows: barrio3Rows } = await cliente.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id",
    [BARRIO_CUOTA_FIJA, administradorId],
  );
  const barrioFijaId = barrio3Rows[0]?.id;
  if (!barrioFijaId) throw new Error("no se pudo crear el barrio de cuota fija");

  const denominacionFija = sugerirDenominacionConcepto("sa")?.denominacion ?? null;
  await cliente.query(
    `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
                         servicios_internos_a_cargo_de, titularidad_espacios_comunes, denominacion_concepto,
                         reglamento_inscripto, pacto_ejecutividad, tiene_espacios_comunes_exclusivos,
                         tiene_consejo, tiene_fondo_reserva, domicilio_sede)
     values ($1,'sa','no_aplica','ure','saldan','urbanizacion','ente',$2,
             true, true, true, true, true, 'Ruta U-111 km 7, Saldán, Córdoba')`,
    [barrioFijaId, denominacionFija],
  );
  await cliente.query(
    `insert into mandato_administracion (barrio_id, administrador_id, desde, notas)
     values ($1,$2, current_date - 900, 'Mandato vigente del barrio de cuota fija')`,
    [barrioFijaId, administradorId],
  );

  // El padrón. Una unidad por lote de la traza; el obligado es ficticio y se arma con un desfasaje
  // distinto al de los otros barrios para que no se repitan los mismos nombres en la demo.
  const unidadesFija: string[] = [];
  let n = 0;
  for (const [manzana, lotes] of Object.entries(TRAZA)) {
    const numeros = typeof lotes === "number" ? Array.from({ length: lotes }, (_, i) => i + 1) : lotes;
    for (const lote of numeros) {
      // ~8 % sin construir: en un loteo de esta antigüedad siempre quedan lotes vacíos, y pagan la
      // cuota igual — que es justo lo que hay que poder mostrar.
      const estado = n % 12 === 0 ? "baldio" : n % 25 === 0 ? "en_construccion" : "construido";
      const { rows } = await cliente.query<{ id: string }>(
        `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2, nomenclatura_catastral)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [
          barrioFijaId,
          manzana,
          String(lote),
          estado,
          (700 + ((n * 37) % 900)).toFixed(2),
          `13-01-${manzana}-${String(lote).padStart(3, "0")}`,
        ],
      );
      const unidadId = rows[0]?.id;
      if (!unidadId) throw new Error("no se pudo crear una unidad del barrio de cuota fija");
      unidadesFija.push(unidadId);

      const nombre = `${NOMBRES[(n * 3 + 1) % NOMBRES.length]} ${APELLIDOS[(n * 7 + 5) % APELLIDOS.length]}`;
      const { rows: oblRows } = await cliente.query<{ id: string }>(
        `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, email, telefono)
         values ($1,$2,'DNI',$3,$4,$5) returning id`,
        [
          barrioFijaId,
          nombre,
          String(20_000_000 + n * 7_013),
          `vecino${manzana}-${lote}@ejemplo.test`,
          `+54 351 5${String(100_000 + n * 13).slice(0, 6)}`,
        ],
      );
      await cliente.query(
        `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
         values ($1,$2,$3,'propietario', current_date - 800, true)`,
        [barrioFijaId, unidadId, oblRows[0]?.id],
      );
      n++;
    }
  }

  // Coeficientes en **partes iguales**: en un loteo de lotes equivalentes, un lote es un voto y una
  // cuota. No reparten la cuota (que es fija) pero sí las extraordinarias, y la base los exige para
  // poder emitir.
  //
  // Cada unidad vale **exactamente 1**, y eso no es una simplificación: con esta base los
  // coeficientes son **pesos relativos**, no fracciones de 1, y `app.validar_coeficientes` exige que
  // **no haya dos valores distintos** —si uno quedara diferente, el barrio creería que reparte en
  // partes iguales sin hacerlo—. Repartir 1 entre 510 con resto a la última unidad, que es lo que
  // hacen los otros dos barrios, produce justamente los dos valores que esa regla prohíbe.
  const { rows: version3Rows } = await cliente.query<{ id: string }>(
    `insert into coeficiente_version (barrio_id, base, descripcion, vigente_desde)
     values ($1,'partes_iguales','Partes iguales: un lote, una cuota (art. estatutario)', current_date - 900)
     returning id`,
    [barrioFijaId],
  );
  const versionFijaId = version3Rows[0]?.id;
  if (!versionFijaId) throw new Error("no se pudo crear la versión de coeficientes del barrio de cuota fija");
  await cliente.query(
    `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor)
     select $1, $2, u, 1 from unnest($3::uuid[]) as u`,
    [barrioFijaId, versionFijaId, unidadesFija],
  );
  await cliente.query("update coeficiente_version set cerrada = true where id = $1", [versionFijaId]);

  // La versión de cuota: un importe, el mismo para las 510. El día que la pantalla permita cambiarla
  // por porcentaje, lo que va a escribir es una versión nueva como ésta.
  const { rows: cuotaVerRows } = await cliente.query<{ id: string }>(
    `insert into cuota_fija_version (barrio_id, descripcion, vigente_desde)
     values ($1,'Cuota mensual vigente, igual para todas las unidades', current_date - 60) returning id`,
    [barrioFijaId],
  );
  const cuotaVersionId = cuotaVerRows[0]?.id;
  if (!cuotaVersionId) throw new Error("no se pudo crear la versión de cuota fija");
  // En un solo `insert` con `unnest`: 510 viajes de ida y vuelta por una cifra que es idéntica en
  // todas las filas es tiempo de arranque regalado cada vez que alguien siembra.
  await cliente.query(
    `insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe)
     select $1, $2, u, $4::numeric from unnest($3::uuid[]) as u`,
    [barrioFijaId, cuotaVersionId, unidadesFija, CUOTA_MENSUAL],
  );

  await cliente.query(
    `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.030000, current_date - 900)`,
    [barrioFijaId],
  );
  await cliente.query(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento, notas)
     values ($1,'estatuto','Estatuto social (demo)', current_date - 3000, 'Documento de ejemplo')`,
    [barrioFijaId],
  );

  // El catálogo de conceptos y los gastos de los dos períodos.
  const conceptosFija = new Map<string, string>();
  for (const [nombre, , tipo] of GASTOS_DEL_MES) {
    const { rows } = await cliente.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal, es_fondo_reserva)
       values ($1,$2,$3,'sin_clasificar',false) returning id`,
      [barrioFijaId, nombre, tipo],
    );
    conceptosFija.set(nombre, rows[0]?.id as string);
  }

  /*
    El catálogo de cargos y descuentos del barrio. **Sin esto la pantalla de cargos no sirve para
    nada**: el formulario existe pero no tiene ningún concepto que ofrecer, y el usuario se topó con
    eso ("no se pudo aplicar ningún cargo a ninguna UF... porque no hay catálogo"). Un barrio demo sin
    catálogo es un barrio donde media pantalla no se puede mostrar.

    Los tres son los del barrio real: el quincho y la cancha se cobran por uso, y la bonificación por
    pago en término se descuenta.
  */
  const CATALOGO_FIJA = [
    {
      nombre: "Uso del Club House",
      clase: "cargo", metodo: "precio_x_cantidad", base: "sin_base", financiamiento: null,
      monto: null, porcentaje: null, precio: "45000.00", tope: null,
    },
    {
      nombre: "Alquiler de cancha de pádel",
      clase: "cargo", metodo: "precio_x_cantidad", base: "sin_base", financiamiento: null,
      monto: null, porcentaje: null, precio: "12000.00", tope: null,
    },
    {
      nombre: "Bonificación por pago en término",
      clase: "descuento", metodo: "porcentaje", base: "expensa_ordinaria", financiamiento: "partida_presupuestada",
      monto: null, porcentaje: "7.500000", precio: null, tope: "30000.00",
    },
    {
      // Un descuento **de monto fijo**, para que la demo muestre las dos formas: hay bonificaciones
      // que son un porcentaje de la expensa y otras que son una cifra, decidida y punto.
      nombre: "Descuento por obra a cargo del propietario",
      clase: "descuento", metodo: "monto_fijo", base: "sin_base", financiamiento: "absorbe_barrio",
      monto: "50000.00", porcentaje: null, precio: null, tope: null,
    },
  ] as const;
  for (const c of CATALOGO_FIJA) {
    const { rows: cRows } = await cliente.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento)
       values ($1,$2,$3,$4,$5,'sin_clasificar',$6) returning id`,
      [barrioFijaId, c.nombre, c.clase, c.metodo, c.base, c.financiamiento],
    );
    await cliente.query(
      `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje,
                                          precio_unitario, tope, vigente_desde)
       values ($1,$2,$3,$4,$5,$6,$7, current_date - 400)`,
      [barrioFijaId, cRows[0]?.id, c.metodo, c.monto, c.porcentaje, c.precio, c.tope],
    );
  }

  const { rows: perFijaRows } = await cliente.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, modelo, cuota_fija_version_id,
                                  primer_vencimiento, segundo_vencimiento, notas)
     values ($1,$2,'fija',$3, current_date + 10, current_date + 20,
             'Cuota fija: lo que se cobra no sale de los gastos') returning id`,
    [barrioFijaId, periodo, cuotaVersionId],
  );
  const periodoFijaId = perFijaRows[0]?.id;
  if (!periodoFijaId) throw new Error("no se pudo crear el período de cuota fija");

  const { rows: borrFijaRows } = await cliente.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, modelo, cuota_fija_version_id,
                                  primer_vencimiento, segundo_vencimiento, notas)
     values ($1,$2,'fija',$3, current_date + 40, current_date + 50,
             'Período en curso del barrio de cuota fija') returning id`,
    [barrioFijaId, mesEnCurso, cuotaVersionId],
  );
  const periodoFijaBorradorId = borrFijaRows[0]?.id;
  if (!periodoFijaBorradorId) throw new Error("no se pudo crear el borrador del barrio de cuota fija");

  // Los gastos van en los DOS períodos: en un barrio de cuota fija el gasto no determina lo que se
  // cobra, pero se registra igual —para la rendición, para fijar la cuota siguiente y para pagarle a
  // los proveedores—. Que la suma no coincida con lo recaudado **es el dato**, no un error.
  for (const periodoDestino of [periodoFijaId, periodoFijaBorradorId]) {
    for (const [nombre, monto] of GASTOS_DEL_MES) {
      await cliente.query(
        `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre)
         values ($1,$2,$3,$4,$5,$6)`,
        [barrioFijaId, periodoDestino, conceptosFija.get(nombre), nombre, monto, "Proveedor contratado"],
      );
    }
  }

  await cliente.query("commit");

  // La liquidación se genera con el MISMO servicio que usa la aplicación (no con SQL a mano): así el
  // demo recorre el camino real y, si algo se rompe, se rompe acá antes que en una demostración.
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  let resumen;
  let resumenFija;
  try {
    const db = crearDbMantenimiento(pool);
    // Con identidad: emitir requiere un usuario de sesión, porque la firma la pone la base.
    // Los cargos y descuentos los carga una PERSONA: van con identidad de sesión, porque la firma de
    // quién los aplicó la pone la base y no se puede falsear desde el cliente.
    await conUsuario(db, usuarioDemo, async (tx) => {
      for (const [nombre, unidadId, datos] of aplicaciones) {
        const catalogo = catalogoBoleta.get(nombre);
        if (!catalogo) throw new Error(`falta el concepto ${nombre} en el catálogo`);
        await tx.execute(sql`
          insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id,
                                              fecha_hecho, cantidad, detalle)
          values (${periodoId}, ${unidadId}, ${catalogo.conceptoId}, current_date,
                  ${datos["cantidad"]}, ${datos["detalle"]})
        `);
      }
    });

    resumen = await conUsuario(db, usuarioDemo, (tx) => generarLiquidaciones(tx, { periodoId }));
    await conUsuario(db, usuarioDemo, (tx) => emitirPeriodo(tx, { periodoId }));

    // El período del barrio de cuota fija, por el mismo camino real. Si el modelo `fija` se rompiera,
    // se rompe acá —al sembrar— y no en una demostración: es la primera vez que ese camino se recorre
    // fuera de los tests.
    resumenFija = await conUsuario(db, usuarioDemo, (tx) => generarLiquidaciones(tx, { periodoId: periodoFijaId }));
    await conUsuario(db, usuarioDemo, (tx) => emitirPeriodo(tx, { periodoId: periodoFijaId }));

    // Un cargo y un descuento en el período EN BORRADOR, aplicados con el **servicio de escritura**
    // real y **con la identidad del operador**, no con SQL a mano. Tres cosas se prueban de un saque
    // cada vez que alguien corre el seed:
    //   · que `aplicarConceptoAUnidad` funciona con los seis campos que el request tiene permitidos;
    //   · que el `operador` llega al tope de `limite_aplicacion_barrio` (si la fila faltara, esto
    //     falla acá y no en una demostración — que es justo lo que el ADR-0002 §7.3 pedía evitar);
    //   · que la pantalla de cargos tiene datos para mostrar en un período editable.
    const quincho = catalogoBoleta.get("Alquiler de quincho");
    const bonificacion = catalogoBoleta.get("Bonificación vecino cumplidor");
    const hoyIso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
    // Ruidoso a propósito: si el catálogo cambia de nombre, el seed tiene que fallar acá y no
    // imprimir "Cargos aplicados: 0" como si fuera lo normal — el propósito declarado de este bloque
    // es probar que el límite del operador está sembrado.
    if (!quincho || !bonificacion) {
      throw new Error("faltan los conceptos de boleta del seed: cambió el catálogo y nadie actualizó esto");
    }
    if (unidades.length < 5) {
      throw new Error(`el seed necesita al menos 5 unidades y hay ${unidades.length}`);
    }
    {
      await conUsuario(db, operadorDemo, async (tx) => {
        await aplicarConceptoAUnidad(tx, {
          periodoId: periodoBorradorId,
          unidadFuncionalId: unidades[4]?.id as string,
          conceptoBoletaId: quincho.conceptoId,
          fechaHecho: hoyIso,
          cantidad: "2",
          detalle: "Reserva del quincho — 2 jornadas (cumpleaños)",
          origenEvaluacion: "carga_manual",
        });
        await aplicarConceptoAUnidad(tx, {
          periodoId: periodoBorradorId,
          unidadFuncionalId: unidades[1]?.id as string,
          conceptoBoletaId: bonificacion.conceptoId,
          fechaHecho: hoyIso,
          cantidad: null,
          detalle: "Sin saldo pendiente al cierre del período anterior",
          origenEvaluacion: "carga_manual",
        });
      });
    }
  } finally {
    await pool.end();
  }

  // --- Resumen para la consola ---------------------------------------------------------------
  const { rows: baldias } = await cliente.query<{ n: string }>(
    "select count(*)::text as n from unidad_funcional where barrio_id = $1 and estado_unidad <> 'construido'",
    [barrioId],
  );

  const { rows: muestra } = await cliente.query<{ etiqueta: string; total: string; coef: string }>(
    `select u.manzana || '-' || u.lote as etiqueta, l.total::text, l.coeficiente_aplicado::text as coef
       from liquidacion l join unidad_funcional u on u.id = l.unidad_funcional_id
      where l.periodo_id = $1 order by l.total desc limit 1`,
    [periodoId],
  );

  const { rows: borrador } = await cliente.query<{ gastos: string; cargado: string; aplicaciones: string; marcados: string }>(
    `select count(*)::text as gastos,
            coalesce(sum(monto), 0)::text as cargado,
            (select count(*) from concepto_boleta_unidad c where c.periodo_id = $1)::text as aplicaciones,
            count(*) filter (where sin_respaldo_asamblea)::text as marcados
       from gasto_periodo where periodo_id = $1`,
    [periodoBorradorId],
  );

  console.log(`Modo demo listo:
  Administrador : ${ADMINISTRADOR}
  Barrio        : ${BARRIO} (PH especial, adecuación en trámite, Villa Allende)
  Segundo barrio: ${BARRIO_SECUNDARIO} (SA, Mendiolaza, sin períodos cargados)
  Tercer barrio : ${BARRIO_CUOTA_FIJA} (SA, Saldán, CUOTA FIJA — ${unidadesFija.length} unidades en 24 manzanas)
  Unidades      : ${unidades.length} (${baldias[0]?.n} baldías o en construcción — generan expensas igual)
  Coeficientes  : versión cerrada, suma exacta = 1

  Elenco de la demo (con estos se entra en /entrar — sin propietarios ni residentes, a propósito):
${elenco.map((p) => `    · ${p.nombre.padEnd(16)} ${p.rol.padEnd(13)} ${p.email}`).join("\n")}

  Período ${periodo} EMITIDO:
    Gastos del período : $ ${resumen.totalGastos}
    Repartido          : $ ${resumen.totalRepartido}  (tiene que ser idéntico)
    Liquidaciones      : ${resumen.unidadesLiquidadas}${resumen.conMoraPendiente > 0 ? ` (${resumen.conMoraPendiente} con mora pendiente de definición)` : ""}
    Cargos de boleta   : $ ${resumen.totalCargos}  (quincho — no reparte gasto común)
    Descuentos         : $ ${resumen.totalDescuentos}  (vecino cumplidor, ya presupuestado)
    Unidad más cara    : MZ ${muestra[0]?.etiqueta} → $ ${muestra[0]?.total} (coeficiente ${muestra[0]?.coef})

  Período ${mesEnCurso} EN BORRADOR (es el que se puede tocar desde las pantallas de carga):
    Gastos cargados    : ${borrador[0]?.gastos} por $ ${borrador[0]?.cargado} (${borrador[0]?.marcados} extraordinaria sin acta, marcada por la base)
    Cargos aplicados   : ${borrador[0]?.aplicaciones}, cargados por el OPERADOR — prueba que el límite del barrio está sembrado
    Liquidaciones      : 0 — "Generar el borrador" todavía tiene algo que hacer`);
} catch (error) {
  await cliente.query("rollback");
  throw error;
} finally {
  await cliente.end();
}
