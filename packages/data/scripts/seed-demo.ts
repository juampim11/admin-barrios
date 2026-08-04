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
      "gasto_periodo", "periodo_expensa", "concepto", "tasa_mora",
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

  await cliente.query("commit");

  // La liquidación se genera con el MISMO servicio que usa la aplicación (no con SQL a mano): así el
  // demo recorre el camino real y, si algo se rompe, se rompe acá antes que en una demostración.
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  let resumen;
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
