/**
 * Schemas Zod de referencia para el dominio (Consorcia).
 * Adaptar nombres a los del repo si ya existen. Importables desde el paquete compartido
 * del monorepo para reusarlos en web y en la futura app React Native.
 */
import { z } from 'zod';

export const Rol = z.enum(['ADMIN_TENANT', 'OPERADOR_CONTABLE', 'CONSEJO', 'VECINO']);
export const BaseReparto = z.enum(['COEFICIENTE', 'SUPERFICIE', 'PARTES_IGUALES', 'MEDIDOR', 'SECTOR']);
export const RubroTipo = z.enum(['ORDINARIO', 'EXTRAORDINARIO', 'FONDO_RESERVA']);
export const EstadoLiquidacion = z.enum(['BORRADOR', 'CERRADA', 'EMITIDA', 'ANULADA']);
export const TipoCuenta = z.enum(['CA_PESOS', 'CC_PESOS', 'FONDO_RESERVA', 'BILLETERA', 'CAJA']);
export const OrigenComprobante = z.enum(['MANUAL', 'OCR', 'EMAIL']);
export const EstadoComprobante = z.enum(['PENDIENTE', 'CONFIRMADO', 'DESCARTADO']);
export const TramoMora = z.enum(['AL_DIA', 'D1_30', 'D31_60', 'D61_90', 'D90_MAS']);

/** Importes en centavos, enteros. Nunca float para plata. */
export const Centavos = z.number().int();
/** Coeficiente en millonésimas de porcentaje: 0,380% => 380_000. Suma del padrón = 100_000_000. */
export const CoeficienteRaw = z.number().int().positive();
export const Periodo = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'formato aaaa-mm');
export const Cuit = z.string().regex(/^\d{2}-\d{8}-\d$/);

export const Tenant = z.object({
  id: z.string(),
  razonSocial: z.string(),
  cuit: Cuit,
});

export const ReglasLiquidacion = z.object({
  baseRepartoDefault: BaseReparto,
  diaPrimerVencimiento: z.number().int().min(1).max(28),
  diaSegundoVencimiento: z.number().int().min(1).max(28).nullable(),
  recargoSegundoVencimiento: z.number().min(0).max(1),
  interesMoraMensual: z.number().min(0).max(1),
  interesCapitalizable: z.boolean(),
  imputacionPagos: z.enum(['DEUDA_MAS_ANTIGUA', 'PERIODO_INDICADO']),
  fondoReservaPorcentaje: z.number().min(0).max(1),
  requiereAprobacionConsejo: z.boolean(),
  publicaEnPortalAlEmitir: z.boolean(),
});

export const Sector = z.object({ id: z.string(), nombre: z.string() });

export const Consorcio = z.object({
  id: z.string(),
  codigo: z.string(),           // "C-04"
  nombre: z.string(),
  cuit: Cuit,
  direccion: z.string(),
  localidad: z.string(),
  sectores: z.array(Sector),
  reglas: ReglasLiquidacion,
  tenantId: z.string(),
});

export const UnidadFuncional = z.object({
  id: z.string(),
  consorcioId: z.string(),
  codigo: z.string(),           // "A-102"
  sectorId: z.string(),
  superficieM2: z.number().positive(),
  coeficiente: CoeficienteRaw,
  titular: z.object({
    nombre: z.string(),
    documento: z.string(),
    email: z.string().email().nullable(),
    telefono: z.string().nullable(),
  }),
  ocupacion: z.enum(['PROPIETARIO', 'ALQUILADA', 'CONDOMINIO', 'EN_SUCESION']),
  debitoAutomatico: z.boolean(),
});

export const Comprobante = z.object({
  id: z.string(),
  consorcioId: z.string(),
  tipo: z.enum(['A', 'B', 'C', 'RECIBO', 'INTERNO']),
  numero: z.string(),
  fecha: z.string(),
  proveedor: z.object({ nombre: z.string(), cuit: Cuit.nullable(), validadoAfip: z.boolean() }),
  rubroId: z.string(),
  neto: Centavos, iva: Centavos, total: Centavos,
  retenciones: Centavos,
  origen: OrigenComprobante,
  estado: EstadoComprobante,
  archivoUrl: z.string().nullable(),
  reclamoId: z.string().nullable(),
});

export const RubroGasto = z.object({
  id: z.string(),
  nombre: z.string(),
  tipo: RubroTipo,
  baseReparto: BaseReparto,
  sectorId: z.string().nullable(),   // requerido si baseReparto === 'SECTOR'
  cuotaActual: z.number().int().nullable(),
  cuotasTotales: z.number().int().nullable(),
});

export const LineaGastoPeriodo = z.object({
  rubroId: z.string(),
  comprobanteIds: z.array(z.string()),
  importe: Centavos,
});

export const DetalleUF = z.object({
  ufId: z.string(),
  ordinarias: Centavos,
  extraordinarias: Centavos,
  fondoReserva: Centavos,
  intereses: Centavos,
  saldoAnterior: Centavos,
  total: Centavos,
});

export const Liquidacion = z.object({
  id: z.string(),
  consorcioId: z.string(),
  periodo: Periodo,
  estado: EstadoLiquidacion,
  vencimiento: z.string(),
  gastos: z.array(LineaGastoPeriodo),
  totalGastos: Centavos,
  totalEmitido: Centavos,
  detalle: z.array(DetalleUF),
  emitidaPor: z.string().nullable(),
  emitidaEn: z.string().nullable(),
  aprobadaPor: z.string().nullable(),
});

export const CuentaBancaria = z.object({
  id: z.string(),
  consorcioId: z.string(),
  banco: z.string(),
  numero: z.string(),
  tipo: TipoCuenta,
  saldo: Centavos,
  admiteGastoOrdinario: z.boolean(),
});

export const MovimientoBancario = z.object({
  id: z.string(),
  cuentaId: z.string(),
  fecha: z.string(),
  descripcion: z.string(),
  importe: Centavos,                   // negativo = egreso
  cuitOrdenante: Cuit.nullable(),
  referencia: z.string().nullable(),
  linkPagoId: z.string().nullable(),
  esMovimientoInterno: z.boolean(),
  conciliadoCon: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('UF'), ufId: z.string() }),
    z.object({ tipo: z.literal('PROVEEDOR'), comprobanteId: z.string() }),
    z.object({ tipo: z.literal('INTERNO'), movimientoId: z.string() }),
    z.object({ tipo: z.literal('SIN_CONCILIAR') }),
  ]),
});

export const Pago = z.object({
  id: z.string(),
  consorcioId: z.string(),
  ufId: z.string(),
  fecha: z.string(),
  importe: Centavos,
  medio: z.enum(['TRANSFERENCIA', 'DEBIN', 'LINK_PAGO', 'DEBITO_AUTOMATICO', 'DEPOSITO', 'EFECTIVO']),
  pagadorEsTitular: z.boolean(),
  estado: z.enum(['INFORMADO', 'ACREDITADO', 'RECHAZADO']),
  movimientoBancarioId: z.string().nullable(),
});

export const PlanPago = z.object({
  id: z.string(),
  ufId: z.string(),
  deudaRefinanciada: Centavos,
  anticipo: Centavos,
  cuotas: z.number().int().min(1),
  interesFinanciacionMensual: z.number(),
  estado: z.enum(['OFRECIDO', 'VIGENTE', 'CADUCADO', 'CUMPLIDO']),
  cuotasImpagas: z.number().int(),
});

export const Reclamo = z.object({
  id: z.string(),
  consorcioId: z.string(),
  ufId: z.string(),
  titulo: z.string(),
  categoria: z.enum(['URGENTE', 'MANTENIMIENTO', 'ADMINISTRATIVO', 'ESPACIOS_COMUNES']),
  estado: z.enum(['ABIERTO', 'EN_CURSO', 'RESUELTO', 'CERRADO']),
  abiertoEn: z.string(),
  asignadoA: z.string().nullable(),
  adjuntos: z.array(z.string()),
  comprobanteId: z.string().nullable(),
});

export type Rol = z.infer<typeof Rol>;
export type Consorcio = z.infer<typeof Consorcio>;
export type UnidadFuncional = z.infer<typeof UnidadFuncional>;
export type Liquidacion = z.infer<typeof Liquidacion>;
export type MovimientoBancario = z.infer<typeof MovimientoBancario>;
