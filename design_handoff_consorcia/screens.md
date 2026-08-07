# Inventario de pantallas

Los ids (`1a`, `2a`, …) son los badges visibles en `Consorcia - Mockups (standalone).html`. La dirección visual elegida es **1a (neutro profesional)**; `1b` y `1c` son direcciones descartadas y quedan sólo como historial (no implementar).

## Chrome común (todas las pantallas del back office)
- **Sidebar** 224px, fondo `#1b1c1e`. Marca arriba; en contexto de consorcio, una tarjeta "CONTEXTO" con nombre, UF y localidad. Ítems de nav de 13px/400 con punto de 5px a la izquierda; el activo lleva fondo `rgba(255,255,255,.10)`, texto blanco y punto en color de acento. Al pie, usuario y tenant.
- **Header** 100% ancho, fondo blanco, borde inferior `rgba(0,0,0,.09)`, padding 12–14px / 24px. Contiene: breadcrumb opcional (`Cartera /`), **selector de contexto** (chip con código del consorcio + nombre + caret), metadatos monoespaciados, y a la derecha acciones secundarias (borde) + primaria (acento) + avatar de 30px.
- **Nav en contexto cartera**: Inicio, Consorcios, Gastos y comprobantes, Pagos y conciliación, Liquidaciones, Padrón, Reportes.
- **Nav en contexto consorcio**: Resumen, Cuentas corrientes, Gastos y comprobantes, Caja y bancos, Liquidaciones, Padrón de UF, Documentos y actas, Consejo y proveedores.
- **Tablas**: header `#faf9f7` con labels de 11px/500 en `#8a8781`; filas separadas por `rgba(0,0,0,.06)`, alternas `#fcfbf9`; celdas 14px vertical (variante compacta 9px); importes a la derecha con `tabular-nums`; códigos e identificadores en monospace 11,5–12px.
- **Estados**: punto de 6px + texto de 12px — verde `#5d9a70`/`#3d6b4a`, ámbar `#c2a05f`/`#8a6a2e`, rojo `#c2705f`/`#a04a3c`.

---

## `1a` Home consolidado de cartera → `/(app)/cartera`
Para el admin del tenant. Grid: sidebar + main. Contenido: título "Cartera · Julio 2026" con timestamp; 4 KPI cards (cobranza del mes con barra de progreso, deuda acumulada con variación, gastos sin imputar, liquidaciones abiertas); grid `1fr 316px` con tabla de consorcios (Consorcio+dirección, UF, Cobranza, Deuda, Últ. cierre, Estado) y filtros por chips (Todos / Con mora / Sin cerrar); panel "Requiere atención" con ítems de barra vertical de color 4px.
Estados: fila hover, filtro activo, panel ocultable (prop `mostrarPanelAtencion`).

## `2b` Selector de contexto → componente global
Dropdown de 560px anclado al chip del header. Secciones: buscador (nombre, CUIT o dirección), **ALCANCE** ("Toda la cartera", con conteo de consorcios y UF — sólo si el rol la tiene), **FIJADOS** (tarjetas con código, nombre, estado de liquidación y % de mora), **TODOS** (lista compacta con código monospace + nombre + UF). Nota al pie: conserva la sección al cambiar de consorcio; `⌘K` lo abre.

## `2c` Homes por alcance de perfil → variantes del home
- **Operador con 3 consorcios**: header sin "Toda la cartera"; 3 tarjetas de trabajo (código, nombre, UF, pendientes concretos). La activa lleva borde de acento.
- **Presidente/consejo con 1 consorcio**: título fijo (no selector), chip "Vista del consejo · sólo lectura"; 4 KPI agregados; card ancha "Liquidación lista para aprobar" con acciones Aprobar / Observar; dos cards que enumeran explícitamente qué puede y qué no puede ver.

## `2a` Resumen del consorcio → `/(app)/c/[consorcioId]`
Header con selector en contexto + CUIT/ejercicio + acciones (Importar extracto, Liquidar julio). Título con dirección, UF y sectores; chips de período (Julio / Junio / Ejercicio). 5 KPI (emitido, cobrado con barra, deuda, disponible en N cuentas, fondo de reserva). Grid `1.4fr 1fr`: card "Gasto del período por rubro" (6 barras horizontales con importe a la derecha + pie con comparativas) y columna con "Mora por antigüedad", "Tareas del consorcio" y "Consejo de administración" (con estado de acceso de cada miembro).

## `4a` Liquidaciones → `/(app)/c/[consorcioId]/liquidaciones`
Card destacada del período en curso: número de mes grande, estado ("en borrador · paso 2 de 3"), resumen de gastos y fechas, acciones Ver planilla / Continuar liquidación. Tabla de períodos emitidos (Período, Gasto, Emitido, Cobrado, Prom./UF, Emisión con cantidad de boletas y reemisiones, Estado con % cobrado). Al pie: mini gráfico de barras de evolución de la expensa promedio, card de acciones sobre un período emitido, card de liquidación masiva.
**Acá vive la entrada al wizard.** El botón "Liquidar julio" del header de `2a` es un atajo a este flujo.

## `1d` Wizard de liquidación → `/(app)/c/[consorcioId]/liquidaciones/[periodo]`
1000px. Header con período + chip "Borrador" + vencimiento y cantidad de UF; stepper de 3 pasos clickeable (círculo de 24px, activo `#1b1c1e`/blanco, inactivo `#e4e2dd`/gris, línea de 1px entre pasos).
- **Paso 1 · Gastos del período**: tabla (Comprobante monospace, Proveedor, Rubro, Distribución como chip de color según base de reparto, Importe) + fila de total "Total a prorratear" + aviso ámbar por comprobantes de OCR sin confirmar.
- **Paso 2 · Prorrateo**: chips de base (Por coeficiente / Por m² / Partes iguales / Mixto por rubro); tabla por UF (UF, Titular, Coef., Ordinarias, Extraord., Interés, Total UF) con pie "suma de coeficientes 100,000%" y total emitido; panel derecho de 260px con **control de cuadratura** (gastos, intereses, prorrateado, diferencia $0 con punto verde) y card de reglas aplicadas.
- **Paso 3 · Revisión y emisión**: previsualización de la boleta (encabezado del consorcio + datos de la UF a la derecha en monospace, líneas de concepto, total destacado, bloque de QR/código de barras como placeholder rayado) + panel de emisión (boletas a generar, envío por email, impresión, débito automático) con acciones Emitir y Descargar PDF de prueba, más card "Al emitir" explicando el efecto.
Footer: autoguardado + Anterior / Continuar.
Estado: `step` (1–3).

## `1e` Alternativa de prorrateo (planilla editable) — implementar sólo si se pide
Grilla por rubro con base de reparto editable como select-chip por fila, columnas Importe / $ por UF promedio / % del total, y panel derecho fijo de cuadratura en vivo (gastos, sin asignar, fondo de reserva, intereses, a emitir) + nota de expensa promedio y variación.

## `1g` Gastos y comprobantes con OCR → `/(app)/c/[consorcioId]/gastos`
Dos columnas iguales. Izquierda: contador "Comprobante 8 de 12", chip "OCR listo", nombre de archivo monospace, visor del comprobante (placeholder rayado, mínimo 420px de alto) y acciones Rotar / Ver original / Descartar. Derecha: campos leídos — proveedor + CUIT con leyenda de validación AFIP en verde; tipo y número + fecha en monospace; consorcio y rubro (el rubro sugerido con borde ámbar y leyenda "sugerido por historial"); neto / IVA / total; imputación como chips (Gasto del período / Extraordinario / Fondo de reserva); card de retenciones a practicar; acciones Confirmar e ir al siguiente / Dejar pendiente.

## `2d` Caja y bancos · conciliación → `/(app)/c/[consorcioId]/bancos`
Header con disponible consolidado. Fila de tarjetas de cuenta (una por cuenta + tarjeta punteada "Agregar cuenta"): punto de estado, banco y tipo, saldo, número y cantidad sin conciliar; la seleccionada lleva borde de acento. Debajo, barra con nombre de la cuenta, chip de período del extracto, hint de conciliados, y acciones Importar extracto / Confirmar N matches automáticos.
Cuerpo en 3 columnas `1fr 300px 1fr`: **movimientos de la cuenta** (seleccionables), **panel central de match sugerido** (importe grande, etiqueta del match, explicación de la regla aplicada, acciones Conciliar / Dividir entre varias UF / Cobranza a identificar) y **contrapartidas del consorcio** (deuda por UF y facturas de proveedor). Nota al pie sobre movimientos internos.
Estados: `acct` (cuenta seleccionada) y `bank` (movimiento seleccionado); las reglas de match cambian según la cuenta.

## `3a` Padrón de UF → `/(app)/c/[consorcioId]/padron`
Grid `1fr 380px`. Izquierda: buscador + chips (Todas / Con deuda / Alquiladas / Sin email); tabla (UF monospace, Titular, Sector, m², Coef., Saldo, Ocupación) con pie que muestra el **control de suma de coeficientes**; 4 cards de resumen por sector con % del coeficiente y notas de excepciones. Derecha: panel de la UF seleccionada (avatar con código, coef. y m², saldo; titular con documento y contacto; inquilino; preferencias de cobro; últimos movimientos; acciones Registrar pago / Editar UF / Transferir titular).

## `1h` Estado de cuenta por UF → `/(app)/c/[consorcioId]/padron/[ufId]`
Encabezado con avatar de código, titular, datos y saldo deudor a la derecha; tabs (Cuenta corriente / Boletas / Reclamos / Plan de pago); tabla debe/haber/saldo con conceptos reales (expensas, extraordinaria, intereses, recibos, saldo refacturado); acciones Registrar pago / Enviar recordatorio / Ofrecer plan en 3 cuotas / Imprimir estado.

## `4b` Cobranza y mora → `/(app)/c/[consorcioId]/mora`
5 tarjetas de tramo (1–30, 31–60, 61–90, +90 con borde rojo, En plan de pago) con UF, importe y **acción sugerida** como link. Grid `1fr 340px`: tabla de deudores del tramo (+90) con UF+titular+nota contextual, períodos, capital, intereses, total y última acción; acciones masivas Seleccionar N / Generar intimaciones. Panel derecho: simulador de plan de pago (deuda, anticipo, cuotas, interés, total; chips de 3/6/12 cuotas; aviso de suspensión de intereses y caducidad) + card de qué se automatiza y qué requiere confirmación humana.

## `3b` Reportes → `/(app)/c/[consorcioId]/reportes`
Header con chips de período (mes / trimestre / ejercicio / personalizado). Grid `220px 1fr`: nav de reportes agrupado en DEL CONSORCIO / IMPOSITIVOS / DE LA CARTERA; contenido con título y subtítulo del reporte, acciones Excel / PDF / Enviar al contador, tabla del **libro de gastos** (Fecha, Comprobante, Proveedor·CUIT, Rubro, Neto, IVA, Retención, Total) con fila de totales, y 3 cards al pie (ordinario vs. extraordinario, trazabilidad de comprobantes, cierre del período con autor y aprobación).

## `3c` Alta y configuración del consorcio → `/(app)/consorcios/nuevo` y `/(app)/c/[consorcioId]/config`
Wizard de 5 pasos (Datos fiscales · Sectores y padrón · **Reglas de liquidación** · Cuentas y cobros · Accesos). El paso 3 mostrado: base de reparto por defecto como chips; tabla de excepciones por rubro; grid de mora (1.º y 2.º vencimiento, interés, imputación de pagos) y toggles (fondo de reserva 3%, publicar en portal al emitir, requerir aprobación del consejo). Panel derecho: **simulación con el último período** (gasto, expensa promedio, UF más baja y más alta, suma prorrateada, aviso verde "cuadra sin resto"), nota de alcance (las reglas son del consorcio, no del tenant; sólo impactan períodos abiertos) y atajo "Copiar configuración de otro consorcio".

## `5a` Reclamos → `/(app)/c/[consorcioId]/reclamos`
Grid `400px 1fr`. Izquierda: chips (Abiertos / Míos / Con gasto / Cerrados) y lista de tickets (id monospace, título, UF + titular + antigüedad + categoría; el seleccionado con fondo `#f4f6fc` y borde izquierdo de acento 3px). Derecha: detalle con id, título, chip de prioridad, metadatos, acciones Asignar / Pedir presupuesto; mensaje del vecino con adjuntos (placeholders rayados de 96×70); caja de respuesta con Responder / Nota interna y plantillas; card "Del reclamo al gasto"; columna de contexto de la UF, proveedores del rubro y SLA del consorcio.

## `5b` Portal del vecino (mobile, 390px) → `/(portal)/mi/[ufId]`
Tres pantallas:
1. **Inicio**: saludo con consorcio y UF; card oscura con total a pagar, vencimiento, nota de intereses y acciones Pagar ahora / Boleta; dos mini cards (saldo, coeficiente); "Mis reclamos" con estado; "Del consorcio" con avisos; tab bar de 5 ítems.
2. **¿Por qué pago esto?**: desglose de la boleta; composición del gasto del consorcio en barras con %; explicación del coeficiente y de las excepciones que no aplican; CTA de pago + PDF.
3. **Informar un pago**: zona de adjunto punteada, importe, fecha, medio (chips), explicación de que queda como "pago informado" y entra a conciliación, CTA Enviar comprobante.
Hit targets ≥ 44px.

## `5c` Cierre masivo de cartera → `/(app)/cartera/cierre/[periodo]`
Header en contexto "Todos los consorcios". Card de progreso con barra segmentada (emitidos / listos / con atención) y acciones Revisar uno por uno / Emitir los N listos. Tabla por consorcio (UF, Gasto, Prom./UF, **Cuadratura**, Estado con el motivo exacto de retención: resto ≠ 0, comprobantes sin confirmar, espera aprobación del consejo). Dos cards al pie: nada se emite a ciegas (cada retenido abre el wizard en el paso que falta) y qué pasa después de emitir (envío por lote, reintento de emails rebotados, progreso por consorcio).
