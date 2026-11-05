# ADR-0011 — El circuito del mes

- **Estado:** aceptado (implementado 2026-11-04, encargo T2).
- **Especificación:** la maqueta aprobada `coordinacion-admin-barrios/maquetas/mes-liquidacion.html`
  (con `estilo-producto.css`), v2: Inicio, Liquidación actual, ficha del mes (Resumen, Gastos y pagos,
  Cargos y descuentos, Boletas, Envío), cuota fija y cuota en Configuración, y los diálogos de emitir,
  enviar, vencimientos y aumento. Las cifras de la maqueta son ilustrativas.
- **Decisiones del titular:** D1, D3, D4 y D5 de `coordinacion-admin-barrios/demo/diagnostico-liquidacion.html`
  (BL-026), que tiene el porqué de cada una. D2 (gastos por un solo camino) y D6 (recurrentes) van en
  tandas posteriores.
- **Migraciones:** `0071_motivo_de_vencimientos` (una columna nullable) y
  `0072_vencimientos_congelados_al_emitir` (una función). Sin DML.
- **Lo que no se toca:** el motor. `calcularLiquidacion`, `prorratearDetallado`, `validar_emision`,
  `resolver_aplicaciones` y `registrarArrastreAlEmitir` se llaman tal cual; cambia **cuándo** se llaman.

---

## 1. D1 — Emitir calcula

**Antes:** «Generar el borrador» guardaba las liquidaciones; cualquier cambio posterior (un gasto, un
pago, una unidad) obligaba a regenerar, y cuatro lugares distintos detectaban el borrador viejo.

**Ahora** (`packages/data/src/servicios/circuito-del-mes.ts`):

- **Vista previa, siempre al día** (`boletasDelMes`). Corre la emisión entera —`generarLiquidaciones`
  con el saldo de la cuenta corriente y el interés a hoy, y `emitirPeriodo`, que valida con
  `app.validar_emision`— dentro de un `savepoint`, lee las boletas y hace `rollback to savepoint`. No
  queda nada: ni liquidaciones, ni firma, ni tramos de interés. Si la emisión no pasaría, la vista
  previa devuelve `bloqueada` con el motivo de la base: **lo que «Bloquea» en pantalla es lo que la
  base rechazaría**, una sola regla.
- **Emitir** (`emitirMes`), en una transacción:
  1. traba el período (`for no key update`, que frena los gastos y cargos, `0023`) y los cobros de
     todas las unidades del barrio (los mismos candados por unidad de `0068`, en orden de id);
  2. calcula y emite con el motor de siempre, con el interés a la fecha de emisión;
  3. compara la **huella** (cantidad, total y un resumen de cada boleta) con la de la última vista
     previa que vio la persona. Si difiere, **no emite**: rechaza con `emision_con_cambios`, diciendo
     qué entró desde entonces (pagos, gastos, cargos) y el total de antes y de ahora. Se confirma con
     una casilla (`CONFIRMACIONES`), y la huella que se compara pasa a ser la de las cifras nuevas: si
     vuelven a cambiar, se pregunta otra vez.
- **Dos emisiones a la vez:** la segunda espera el período trabado y lo encuentra emitido. Una gana.
- **Un borrador del circuito viejo** (liquidaciones ya generadas): no hace falta decidir nada. La vista
  previa y la emisión lo recalculan, igual que hacía «Generar el borrador»; lo guardado se pisa al emitir.
- **Cuánto traba el barrio:** Los Aromos (460 unidades) tarda **7,3 a 7,9 s** en emitir (medido con la
  demo, 3 corridas). La vista previa tarda lo mismo (~7,5 s) porque es la misma cuenta; la mayor parte es
  `deudaALaFecha` bajo RLS (~3,9 s, dos veces). Las pantallas la cargan en diferido. Optimizar
  `deudaALaFecha` sin cambiar su resultado queda para `dba-data`.
- **Mientras se calcula una vista previa**, el período queda trabado como al generar: un gasto que se
  carga en ese momento espera unos segundos.

## 2. El mes se abre solo

`abrirMesEnCurso`: si el barrio no tiene el período del mes en curso (en su hora), la ficha lo abre al
entrar, sin botón. Modelo: `barrio.modelo_liquidacion` (o el del último período). Primer vencimiento:
`barrio.dia_vencimiento`, el mismo mes en cuota fija y el siguiente por coeficiente, como en la maqueta.
El barrio **no tiene configuración del segundo vencimiento**: queda vacío y se carga en «Cambiar»
(diálogo de vencimientos, `cambiarVencimientos`, con motivo en `periodo_expensa.motivo_vencimientos`,
solo antes de emitir). Un rol de solo lectura no lo abre: ve que el mes todavía no se abrió.

**Después de emitir, los vencimientos no se cambian** (`0072`, pedido de `security-engineer`): `0030`
los había dejado afuera del congelamiento como «datos de gestión», pero el interés por mora corre desde
el primer vencimiento, así que cambiarlo en un mes emitido cambiaba lo que se cobra sin que la boleta lo
dijera. Ahora la base lo rechaza aunque se vaya directo a la tabla.

## 3. D3 — «Revisada» desaparece de la vista

Ninguna pantalla ni filtro la ofrece. Los datos no se tocan: un período en `revisada` se muestra como
«Preparando» y se emite igual (`estadoDelMes`).

## 4. D4 — La cuota fija en Configuración del barrio

Valor vigente, historial (`historialDeCuota`: mes, cuota, aumento, acta, quién y cuándo, programado),
aumento por porcentaje con redondeo, «rige desde», acta y «a quién alcanza», con `definirCuotaFija`
(sin cambios). En el mes, «Aplicar aumento desde este mes» abre el mismo formulario. Se va la pantalla
«Valor de la expensa» de Liquidación.

## 5. D5 — Después de emitir se encadena solo

Al emitir se encolan las boletas en PDF y el informe del mes (cada uno en un `savepoint`: si quien emite
no puede encolar alguno, la emisión no se cae). Cuando el worker termina las boletas, encola el paquete
(`encadenarElPaquete`, con la identidad de quien emitió; no duplica). El envío por correo queda como la
única acción explícita: «Enviar N boletas», con su diálogo.

## 6. Lo que falta

`loQueFaltaDelMes`: **Bloquea** solo el rechazo de la vista previa. **Avisa**: órdenes de pago sin
aprobar, gastos extraordinarios sin respaldo de asamblea (la base deja emitirlos), el mes sin
vencimiento y, por coeficiente, el mes sin gastos (con los del mes anterior).

La maqueta muestra «sin respaldo de asamblea» como bloqueo. Acá se muestra como aviso porque la base lo
deja emitir y la regla es «la misma en pantalla y en la base». Si el titular lo quiere como bloqueo, es
una regla nueva de la base (migración) y se decide aparte.

## 7. Pantallas

Ver la sección «Circuito del mes (T2)» de `docs/producto/guia-de-prueba.md`, una tabla por pantalla.
